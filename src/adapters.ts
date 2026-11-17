import type { Connection } from "./config";
import { readLimited, ServiceError } from "./errors";
import type { GenerationResult, Protocol, RunRequest } from "./schema";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const items = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const textBlocks = (content: unknown, type: string) =>
  items(content)
    .map(object)
    .filter((block) => block.type === type && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");

export interface ModelAdapter {
  path: string;
  build(request: RunRequest): Json;
  extract(body: Json): Omit<GenerationResult, "request_id" | "duration_ms">;
}

export const adapters: Record<Protocol, ModelAdapter> = {
  "openai-chat": {
    path: "chat/completions",
    build(request) {
      const messages = [{ role: "user", content: request.prompt }];
      if (request.system_prompt !== undefined)
        messages.unshift({ role: "system", content: request.system_prompt });
      return {
        ...request.parameters,
        model: request.model,
        messages,
        stream: false,
        n: 1,
      };
    },
    extract(body) {
      const choice = object(items(body.choices)[0]);
      const message = object(choice.message);
      const reason =
        typeof choice.finish_reason === "string"
          ? choice.finish_reason
          : undefined;
      return {
        text:
          typeof message.content === "string"
            ? message.content
            : textBlocks(message.content, "text"),
        model: typeof body.model === "string" ? body.model : undefined,
        finish_reason: reason,
        usage: body.usage,
        incomplete: reason !== "stop",
      };
    },
  },
  "openai-responses": {
    path: "responses",
    build(request) {
      return {
        ...request.parameters,
        model: request.model,
        input: [{ role: "user", content: request.prompt }],
        ...(request.system_prompt !== undefined
          ? { instructions: request.system_prompt }
          : {}),
        stream: false,
        store: false,
        background: false,
      };
    },
    extract(body) {
      const messages = items(body.output)
        .map(object)
        .filter((item) => item.type === "message" && item.role === "assistant");
      const finalMessages = messages.filter(
        (item) => item.phase === "final_answer",
      );
      const selected = finalMessages.length
        ? finalMessages
        : messages.filter((item) => item.phase == null);
      const text = selected
        .map((item) => textBlocks(item.content, "output_text"))
        .join("");
      const status = typeof body.status === "string" ? body.status : undefined;
      const reason = object(body.incomplete_details).reason;
      return {
        text,
        model: typeof body.model === "string" ? body.model : undefined,
        response_status: status,
        finish_reason: typeof reason === "string" ? reason : status,
        incomplete_details: body.incomplete_details ?? undefined,
        usage: body.usage,
        incomplete: body.status !== "completed",
      };
    },
  },
  anthropic: {
    path: "messages",
    build(request) {
      return {
        ...request.parameters,
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        ...(request.system_prompt !== undefined
          ? { system: request.system_prompt }
          : {}),
        stream: false,
      };
    },
    extract(body) {
      const reason =
        typeof body.stop_reason === "string" ? body.stop_reason : undefined;
      return {
        text: textBlocks(body.content, "text"),
        model: typeof body.model === "string" ? body.model : undefined,
        finish_reason: reason,
        usage: body.usage,
        incomplete: reason !== "end_turn" && reason !== "stop_sequence",
      };
    },
  },
};

export async function generate(
  connection: Connection,
  request: RunRequest,
  signal: AbortSignal,
): Promise<GenerationResult> {
  const adapter = adapters[connection.protocol];
  // base_url is the API root, normally ending in /v1. Preserve gateway prefixes.
  const url = `${connection.base_url}/${adapter.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (connection.auth === "x-api-key")
    headers["x-api-key"] = connection.api_key;
  else headers.Authorization = `Bearer ${connection.api_key}`;
  if (connection.protocol === "anthropic")
    headers["anthropic-version"] = connection.anthropic_version;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(adapter.build(request)),
      signal,
      redirect: "manual",
    });
  } catch (cause) {
    throw new ServiceError(
      signal.aborted ? "upstream_timeout" : "upstream_network_error",
      signal.aborted
        ? "Upstream generation was interrupted or timed out; execution may have occurred"
        : "Could not reach upstream",
      "generation",
      502,
      {
        url,
        protocol: connection.protocol,
        duration_ms: Math.round(performance.now() - started),
      },
      cause,
    );
  }
  const upstreamHeaders = Object.fromEntries(
    [
      "content-type",
      "request-id",
      "x-request-id",
      "retry-after",
      "cf-ray",
    ].flatMap((name) =>
      response.headers.has(name) ? [[name, response.headers.get(name)]] : [],
    ),
  );
  let bodyText: string;
  try {
    bodyText = await readLimited(response, 4 * 1024 * 1024);
  } catch (cause) {
    throw new ServiceError(
      "upstream_body_error",
      "Could not read complete upstream response",
      "generation",
      502,
      {
        url,
        upstream_status: response.status,
        upstream_headers: upstreamHeaders,
      },
      cause,
    );
  }
  const details = {
    url,
    protocol: connection.protocol,
    upstream_status: response.status,
    upstream_headers: upstreamHeaders,
    response_body: bodyText,
  };
  if (!response.ok) {
    throw new ServiceError(
      "upstream_http_error",
      `Upstream returned HTTP ${response.status}`,
      "generation",
      502,
      details,
    );
  }
  let body: Json;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Expected a JSON object");
    body = object(parsed);
  } catch (cause) {
    throw new ServiceError(
      "upstream_invalid_json",
      "Upstream returned invalid JSON",
      "generation",
      502,
      details,
      cause,
    );
  }
  if (body.error || body.type === "error") {
    throw new ServiceError(
      "upstream_api_error",
      "Upstream returned an API error",
      "generation",
      502,
      details,
    );
  }
  const result = adapter.extract(body);
  if (!result.text.trim() && (!result.incomplete || !result.finish_reason)) {
    throw new ServiceError(
      "upstream_empty_output",
      "Upstream returned no usable generated text",
      "generation",
      502,
      details,
    );
  }
  return {
    ...result,
    request_id:
      response.headers.get("request-id") ??
      response.headers.get("x-request-id") ??
      undefined,
    duration_ms: Math.round(performance.now() - started),
  };
}
