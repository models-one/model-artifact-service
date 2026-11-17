import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/app";
import { parseConfig } from "../src/config";
import { extractSvg, SvgRenderer } from "../src/renderer";
import type { Protocol, Run, RunRequest } from "../src/schema";
import { sha256 } from "../src/schema";
import { RunStore } from "../src/store";

const tokenA = "test-caller-a-0000000000000000000000000000";
const tokenB = "test-caller-b-0000000000000000000000000000";
const expiredToken = "test-expired-0000000000000000000000000000";
const upstreamKey = "fixture-upstream-credential-1234567890";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>circle { fill: #ffa500 }</style><circle cx="50" cy="50" r="25"/><text x="10" y="20">Pelican</text></svg>';
const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic"];
type UpstreamBody = Record<string, unknown>;
const cleanups: (() => Promise<void>)[] = [];
const errors: string[] = [];
const logSpy = spyOn(console, "error").mockImplementation((value: unknown) =>
  errors.push(String(value)),
);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  errors.length = 0;
});

function upstreamResponse(path: string, text = svg, incomplete = false) {
  const shared = {
    model: "provider-model",
    usage: { input_tokens: 12, output_tokens: 34 },
  };
  if (path.endsWith("/messages"))
    return {
      ...shared,
      type: "message",
      role: "assistant",
      stop_reason: incomplete ? "max_tokens" : "end_turn",
      content: [
        { type: "thinking", thinking: "not final output" },
        { type: "text", text },
      ],
    };
  if (path.endsWith("/responses"))
    return {
      ...shared,
      status: incomplete ? "incomplete" : "completed",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    };
  return {
    ...shared,
    choices: [
      {
        index: 0,
        finish_reason: incomplete ? "length" : "stop",
        message: { role: "assistant", content: text },
      },
    ],
  };
}

async function fixture(
  options: {
    handler?: (
      request: Request,
      body: UpstreamBody,
    ) => Response | Promise<Response>;
    queueLimit?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "artifact-service-test-"));
  const seen: { url: string; headers: Headers; body: UpstreamBody }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as UpstreamBody;
      seen.push({ url: request.url, headers: request.headers, body });
      return (
        options.handler?.(request, body) ??
        Response.json(upstreamResponse(new URL(request.url).pathname), {
          headers: { "request-id": "upstream-request-123" },
        })
      );
    },
  });
  const config = parseConfig(
    {
      data_dir: directory,
      queue_limit: options.queueLimit ?? 100,
      connections: protocols.map((protocol) => ({
        id: protocol,
        protocol,
        base_url: `${upstream.url.origin}/gateway/v1`,
        api_key_env: "UPSTREAM_KEY",
        allow_http: true,
      })),
      clients: [
        {
          id: "a",
          token_env: "TOKEN_A",
          connections: protocols,
          allow_render: true,
          retention: { max_items: 2, max_age_seconds: 604800 },
        },
        { id: "b", token_env: "TOKEN_B", connections: protocols },
        {
          id: "expired",
          token_env: "TOKEN_EXPIRED",
          connections: protocols,
          expires_at: "2000-01-01T00:00:00Z",
        },
      ],
    },
    {
      UPSTREAM_KEY: upstreamKey,
      TOKEN_A: tokenA,
      TOKEN_B: tokenB,
      TOKEN_EXPIRED: expiredToken,
    },
  );
  const service = createService(config);
  cleanups.push(async () => {
    await service.close();
    upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}, token = tokenA) =>
    service.app.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  const submit = (body: unknown, key?: string, token = tokenA) =>
    request(
      "/v1/runs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify(body),
      },
      token,
    );
  return { directory, config, service, upstream, seen, request, submit };
}

function input(protocol: Protocol = "openai-chat"): RunRequest {
  return {
    connection_id: protocol,
    model: "caller-model",
    prompt: "请画一只骑自行车的鹈鹕，车轮为蓝色",
    system_prompt: "Return a self-contained SVG.",
    parameters:
      protocol === "openai-responses"
        ? { max_output_tokens: 8192, temperature: 0 }
        : { max_tokens: 8192, temperature: 0 },
    output: { type: "svg", preview_width: 128 },
    metadata: { external_id: "caller-001" },
  };
}

describe("protocol-to-artifact contract", () => {
  for (const protocol of protocols)
    test(`${protocol}: preserves prompt/zero values, extracts final text and produces a real PNG`, async () => {
      const fx = await fixture();
      const response = await fx.submit(input(protocol));
      expect(response.status).toBe(202);
      const created = (await response.json()) as Run;
      await fx.service.runner.idle();
      const run = (await (
        await fx.request(`/v1/runs/${created.id}`)
      ).json()) as Run;
      expect(run.status).toBe("succeeded");
      expect(run.generation).toMatchObject({
        model: "provider-model",
        request_id: "upstream-request-123",
        usage: { input_tokens: 12, output_tokens: 34 },
      });
      expect(fx.seen).toHaveLength(1);
      const sent = fx.seen[0];
      expect(sent?.body).toMatchObject({
        model: "caller-model",
        temperature: 0,
        stream: false,
      });
      expect(JSON.stringify(sent?.body)).toContain(input(protocol).prompt);
      expect(sent?.url).toContain("/gateway/v1/");
      if (protocol === "anthropic") {
        expect(sent?.headers.get("x-api-key")).toBe(upstreamKey);
        expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
        expect(sent?.body.system).toBe(input(protocol).system_prompt ?? "");
      } else
        expect(sent?.headers.get("authorization")).toBe(
          `Bearer ${upstreamKey}`,
        );
      const png = run.artifacts.find((artifact) => artifact.type === "png");
      expect(png).toBeDefined();
      const preview = await fx.request(png?.path ?? "");
      expect(preview.headers.get("content-type")).toBe("image/png");
      const bytes = Buffer.from(await preview.arrayBuffer());
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(128);
      expect(bytes.readUInt32BE(20)).toBe(128);
      expect(sha256(bytes)).toBe(png?.sha256 ?? "");
      const raw = run.artifacts.find(
        (artifact) => artifact.type === "raw_text",
      );
      expect(await (await fx.request(raw?.path ?? "")).text()).toBe(svg);
      const source = await fx.request(
        run.artifacts.find((artifact) => artifact.type === "svg")?.path ?? "",
      );
      expect(source.headers.get("content-disposition")).toStartWith(
        "attachment;",
      );
      expect(source.headers.get("x-content-type-options")).toBe("nosniff");
    });

  for (const protocol of protocols)
    test(`${protocol}: truncated generation retains partial output and usage without producing a misleading preview`, async () => {
      const fx = await fixture({
        handler: (req) =>
          Response.json(
            upstreamResponse(new URL(req.url).pathname, "<svg>partial", true),
          ),
      });
      const created = (await (await fx.submit(input(protocol))).json()) as Run;
      await fx.service.runner.idle();
      const run = (await (
        await fx.request(`/v1/runs/${created.id}`)
      ).json()) as Run;
      expect(run.status).toBe("failed");
      expect(run.error?.code).toBe("generation_incomplete");
      expect(run.generation?.usage).toEqual({
        input_tokens: 12,
        output_tokens: 34,
      });
      expect(run.artifacts.map((artifact) => artifact.type)).toEqual([
        "raw_text",
      ]);
    });
});

test("upstream HTTP diagnostics preserve status/body/request id and redact credentials in both API and logs", async () => {
  const escapedKey = Array.from(upstreamKey)
    .map(
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .join("");
  const fx = await fixture({
    handler: () =>
      new Response(
        `{"error":{"code":"rate_limit","message":"credential=${escapedKey}; caller=${tokenA}","api_key":"${upstreamKey}","refresh_token":"unknown-refresh-token","cookie":"session=unknown-cookie"}}`,
        {
          status: 429,
          headers: {
            "x-request-id": "debug-id",
            "retry-after": "20",
            "set-cookie": "private-cookie",
          },
        },
      ),
  });
  const created = (await (await fx.submit(input())).json()) as Run;
  await fx.service.runner.idle();
  const response = await fx.request(`/v1/runs/${created.id}`);
  const text = await response.text();
  const run = JSON.parse(text) as Run;
  expect(run.error).toMatchObject({
    code: "upstream_http_error",
    stage: "generation",
    details: {
      upstream_status: 429,
      upstream_headers: { "x-request-id": "debug-id", "retry-after": "20" },
    },
  });
  expect(run.error?.details?.response_body).toContain("rate_limit");
  expect(run.error?.causes?.[0]?.stack).toBeString();
  const decoded = JSON.parse(String(run.error?.details?.response_body));
  expect(decoded.error.message).not.toContain(upstreamKey);
  expect(decoded.error.refresh_token).toBe("[REDACTED]");
  expect(decoded.error.cookie).toBe("[REDACTED]");
  for (const event of errors.map((line) => JSON.parse(line))) {
    if (event.error?.details?.response_body) {
      expect(
        JSON.parse(event.error.details.response_body).error.message,
      ).not.toContain(upstreamKey);
    }
  }
  for (const output of [text, errors.join("\n")]) {
    expect(output).not.toContain(upstreamKey);
    expect(output).not.toContain(tokenA);
    expect(output).not.toContain("private-cookie");
    expect(output).not.toContain("unknown-refresh-token");
    expect(output).not.toContain("unknown-cookie");
    expect(output).toContain("[REDACTED]");
  }
});

test("invalid JSON and connection failures retain low-level causes without retries", async () => {
  const fx = await fixture({
    handler: () => new Response("<html>gateway exploded</html>"),
  });
  const first = (await (await fx.submit(input())).json()) as Run;
  await fx.service.runner.idle();
  const invalid = fx.service.runs.get(first.id, "a");
  expect(invalid?.error?.code).toBe("upstream_invalid_json");
  expect(invalid?.error?.details?.response_body).toBe(
    "<html>gateway exploded</html>",
  );
  expect(
    invalid?.error?.causes?.some((cause) => cause.name === "SyntaxError"),
  ).toBe(true);
  fx.upstream.stop(true);
  const second = (await (await fx.submit(input())).json()) as Run;
  await fx.service.runner.idle();
  const network = fx.service.runs.get(second.id, "a");
  expect(network?.error?.code).toBe("upstream_network_error");
  expect(network?.error?.causes?.length).toBeGreaterThan(1);
  expect(fx.seen).toHaveLength(1);
});

test("client isolation applies to records, list, artifacts and expired/missing credentials", async () => {
  const fx = await fixture();
  const created = (await (await fx.submit(input())).json()) as Run;
  await fx.service.runner.idle();
  const run = fx.service.runs.get(created.id, "a");
  expect((await fx.request(`/v1/runs/${created.id}`, {}, tokenB)).status).toBe(
    404,
  );
  expect(
    (await fx.request(run?.artifacts[0]?.path ?? "", {}, tokenB)).status,
  ).toBe(404);
  expect(
    (await (await fx.request("/v1/runs", {}, tokenB)).json()).data,
  ).toEqual([]);
  expect((await fx.request("/v1/runs", {}, expiredToken)).status).toBe(401);
  expect((await fx.service.app.request("/v1/runs")).status).toBe(401);
  fx.config.clients[0]?.connections.splice(0);
  expect((await fx.submit(input())).status).toBe(403);
});

test("idempotency survives capacity limits and rejects changed input without a duplicate upstream call", async () => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fx = await fixture({
    queueLimit: 1,
    handler: async (req) => {
      received.resolve();
      await release.promise;
      return Response.json(upstreamResponse(new URL(req.url).pathname));
    },
  });
  try {
    const first = (await (await fx.submit(input(), "same")).json()) as Run;
    await received.promise;
    const replay = await fx.submit(
      { ...input(), parameters: { temperature: 0, max_tokens: 8192 } },
      "same",
    );
    expect(replay.status).toBe(202);
    expect((await replay.json()).id).toBe(first.id);
    expect(
      (await fx.submit({ ...input(), prompt: "different" }, "same")).status,
    ).toBe(409);
    const full = await fx.submit(input(), "different");
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("5");
    expect(fx.seen).toHaveLength(1);
  } finally {
    release.resolve();
  }
  await fx.service.runner.idle();
});

test("unsupported parameters and oversized/invalid requests fail before calling upstream", async () => {
  const fx = await fixture();
  for (const parameters of [
    { model: "override" },
    { max_tokens: -1 },
    { max_tokens: 1000001 },
    { stream: true },
    { n: 2 },
  ]) {
    expect((await fx.submit({ ...input(), parameters })).status).toBe(422);
  }
  expect(
    (await fx.submit({ ...input("anthropic"), parameters: {} })).status,
  ).toBe(422);
  expect(
    (await fx.submit({ ...input(), prompt: "a".repeat(270000) })).status,
  ).toBe(413);
  expect(
    (await fx.request("/v1/runs", { method: "POST", body: "{}" })).status,
  ).toBe(415);
  expect((await fx.request("/v1/runs?limit=100000")).status).toBe(422);
  expect(fx.seen).toHaveLength(0);
});

test("unsafe SVG is rejected with the original output retained and a useful parser reason", async () => {
  const badSvg =
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>';
  const fx = await fixture({
    handler: (req) =>
      Response.json(upstreamResponse(new URL(req.url).pathname, badSvg)),
  });
  const created = (await (await fx.submit(input())).json()) as Run;
  await fx.service.runner.idle();
  const run = fx.service.runs.get(created.id, "a");
  expect(run?.error?.code).toBe("svg_rejected");
  expect(run?.error?.causes?.at(-1)?.message).toContain("image");
  expect(run?.artifacts.map((artifact) => artifact.type)).toEqual(["raw_text"]);
  for (const content of [
    "<script>alert(1)</script>",
    "<foreignObject>html</foreignObject>",
    '<use href="https://example.invalid/remote.svg#x"/>',
    '<path fill="url(file:///private/data)"/>',
    '<style>@import "https://example.invalid/x.css";</style>',
    '<animate attributeName="x"/>',
    '<path onload="alert(1)"/>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/data">]><text>&x;</text>',
  ])
    expect(() =>
      extractSvg(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`),
    ).toThrow();
  const refs =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0H10V10Z"/></svg>';
  expect(extractSvg(`Here is the picture:\n\`\`\`svg\n${refs}\n\`\`\``)).toBe(
    refs,
  );
});

test("renderer rejects excessive image dimensions and reports child-process details", async () => {
  for (const source of [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="100000"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="256"/>',
  ]) {
    try {
      await new SvgRenderer().render(source, 1024, AbortSignal.timeout(10000));
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "render_failed",
        stage: "rendering",
        details: { exit_code: 1 },
      });
      expect(
        String((error as { details: { stderr: string } }).details.stderr),
      ).toContain("dimensions exceed limits");
    }
  }
});

test("Responses final answer excludes commentary drafts from the saved SVG", async () => {
  const finalSvg = svg.replace("Pelican", "Final answer");
  const fx = await fixture({
    handler: () =>
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: svg }],
          },
          {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: finalSvg }],
          },
        ],
      }),
  });
  const created = (await (
    await fx.submit(input("openai-responses"))
  ).json()) as Run;
  await fx.service.runner.idle();
  const run = fx.service.runs.get(created.id, "a");
  expect(run?.status).toBe("succeeded");
  const raw = run?.artifacts.find((artifact) => artifact.type === "raw_text");
  expect(await (await fx.request(raw?.path ?? "")).text()).toBe(finalSvg);
});

test("Responses preserves the precise incomplete reason and usage even when reasoning exhausts the budget before text", async () => {
  for (const sample of [
    { reason: "max_output_tokens", text: "<svg>partial" },
    { reason: "content_filter", text: "<svg>partial" },
    { reason: "max_output_tokens", text: "" },
  ]) {
    const fx = await fixture({
      handler: () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: sample.reason },
          usage: { input_tokens: 10, output_tokens: 20 },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: sample.text }],
            },
          ],
        }),
    });
    const created = (await (
      await fx.submit(input("openai-responses"))
    ).json()) as Run;
    await fx.service.runner.idle();
    const run = fx.service.runs.get(created.id, "a");
    expect(run?.error).toMatchObject({
      code: "generation_incomplete",
      details: {
        response_status: "incomplete",
        incomplete_details: { reason: sample.reason },
      },
    });
    expect(run?.generation).toMatchObject({
      finish_reason: sample.reason,
      response_status: "incomplete",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  }
});

test("ordinary Basic and Bearer text remains byte-for-byte unchanged in generated artifacts", async () => {
  const original = svg.replace("Pelican", "Basic shapes; Bearer of news");
  const fx = await fixture({
    handler: (request) =>
      Response.json(upstreamResponse(new URL(request.url).pathname, original)),
  });
  const created = (await (await fx.submit(input())).json()) as Run;
  await fx.service.runner.idle();
  const run = fx.service.runs.get(created.id, "a");
  expect(run?.status).toBe("succeeded");
  for (const artifact of run?.artifacts.filter(
    (artifact) => artifact.type !== "png",
  ) ?? []) {
    expect(await (await fx.request(artifact.path)).text()).toBe(original);
  }
});

test("restart resumes saved output without generation and marks unknown execution interrupted", async () => {
  const fx = await fixture();
  const completed = (await (
    await fx.submit(input(), "persisted-key")
  ).json()) as Run;
  await fx.service.runner.idle();
  const original = fx.service.runs.get(completed.id, "a");
  expect(original).toBeDefined();
  const resumed: Run = {
    ...(original as Run),
    status: "running",
    stage: "rendering",
  };
  resumed.artifacts = resumed.artifacts.filter(
    (artifact) => artifact.type !== "png",
  );
  fx.service.runs.save(resumed);
  const unknown: Run = {
    ...resumed,
    id: "run_unknown",
    stage: "generation",
    generation: undefined,
    artifacts: [],
  };
  fx.service.runs.enqueue(unknown, "unknown", "unknown", 100);
  await fx.service.close();
  const restarted = createService(fx.config);
  // The original service is already closed; replace its cleanup before reopening.
  cleanups.pop();
  cleanups.push(async () => {
    await restarted.close();
    fx.upstream.stop(true);
    await rm(fx.directory, { recursive: true, force: true });
  });
  await restarted.runner.idle();
  expect(restarted.runs.get(resumed.id, "a")?.status).toBe("succeeded");
  expect(restarted.runs.get(unknown.id, "a")?.error?.code).toBe(
    "execution_interrupted",
  );
  expect(fx.seen).toHaveLength(1);
  const replay = await restarted.app.request("/v1/runs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenA}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "persisted-key",
    },
    body: JSON.stringify(input()),
  });
  expect((await replay.json()).id).toBe(resumed.id);
});

test("one data volume refuses a second executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-lock-test-"));
  const first = new RunStore(directory);
  try {
    expect(() => new RunStore(directory)).toThrow();
  } finally {
    first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("published OpenAPI exposes individually addressable task and artifact routes", async () => {
  const fx = await fixture();
  const document = await (await fx.service.app.request("/openapi.json")).json();
  expect(document.paths["/v1/runs/{id}"].get.responses["200"]).toBeDefined();
  expect(
    document.paths["/v1/artifacts/{id}"].get.responses["200"].content[
      "image/png"
    ],
  ).toBeDefined();
  expect(document.paths["/v1/runs"].get.responses["401"]).toBeDefined();
});

// Restore console on module teardown without suppressing assertions about logs.
test("provided outputs render without an upstream connection and are idempotent", async () => {
  const fx = await fixture();
  const body = {
    text: svg,
    model: "provided-model",
    collection_key: "channel-model",
    generated_at: new Date().toISOString(),
    output: { type: "svg", preview_width: 128 },
    generation: { duration_ms: 1200 },
  };
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": "import-1",
  };
  const created = await fx.request("/v1/renders", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(created.status).toBe(202);
  const run = (await created.json()) as Run;
  expect(run.input_text).toBeUndefined();
  await fx.service.runner.idle();
  const result = (await (await fx.request(`/v1/runs/${run.id}`)).json()) as Run;
  expect(result.status).toBe("succeeded");
  expect(result.source).toBe("provided");
  expect(result.artifacts.map((artifact) => artifact.type)).toEqual([
    "raw_text",
    "svg",
    "png",
  ]);
  const replay = await fx.request("/v1/renders", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect((await replay.json()).id).toBe(run.id);
  expect(fx.seen).toHaveLength(0);
  expect(
    (
      await fx.request(
        "/v1/renders",
        { method: "POST", headers, body: JSON.stringify(body) },
        tokenB,
      )
    ).status,
  ).toBe(403);
  const config = parseConfig(
    {
      data_dir: fx.directory,
      clients: [{ id: "renderer", token_env: "TOKEN_A", allow_render: true }],
    },
    { TOKEN_A: tokenA },
  );
  expect(config.connections.size).toBe(0);
});

test("retention removes the oldest collection files and tombstones prevent resurrection", async () => {
  const fx = await fixture();
  const imported: { body: unknown; run: Run }[] = [];
  for (const index of [0, 1, 2]) {
    const body = {
      text: svg,
      model: "model",
      collection_key: "same-channel-model",
      generated_at: new Date(Date.now() - (3 - index) * 60000).toISOString(),
      output: { type: "svg", preview_width: 128 },
      generation: { duration_ms: 10 },
    };
    const response = await fx.request("/v1/renders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `retention-${index}`,
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    const created = (await response.json()) as Run;
    await fx.service.runner.idle();
    imported.push({
      body,
      run: (await (await fx.request(`/v1/runs/${created.id}`)).json()) as Run,
    });
  }
  const oldest = imported[0];
  if (!oldest) throw new Error("Fixture was not created");
  expect((await fx.request(`/v1/runs/${oldest.run.id}`)).status).toBe(410);
  expect((await fx.request(oldest.run.artifacts[0]?.path ?? "")).status).toBe(
    404,
  );
  await fx.service.cleanup();
  for (const artifact of oldest.run.artifacts)
    expect(
      await Bun.file(join(fx.directory, "artifacts", artifact.id)).exists(),
    ).toBe(false);
  const replay = await fx.request("/v1/renders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "retention-0",
    },
    body: JSON.stringify(oldest.body),
  });
  expect(replay.status).toBe(410);
  expect((await (await fx.request("/v1/runs")).json()).data).toHaveLength(2);
  const survivor = imported[2]?.run;
  if (!survivor) throw new Error("Missing survivor");
  // Advance the cleanup clock deterministically; no sleep or wall-clock race.
  const expired = fx.service.runs.deletionCandidates(Date.now() + 604800000);
  expect(expired.map((run) => run.id)).toContain(survivor.id);
  await fx.service.cleanup();
  expect((await fx.request(`/v1/runs/${survivor.id}`)).status).toBe(410);
  for (const artifact of survivor.artifacts)
    expect(
      await Bun.file(join(fx.directory, "artifacts", artifact.id)).exists(),
    ).toBe(false);
});

test("already expired imports are rejected and failed deletion resumes after restart", async () => {
  const fx = await fixture();
  const body = {
    text: svg,
    model: "model",
    collection_key: "expiry",
    generated_at: new Date(Date.now() - 604801000).toISOString(),
    output: { type: "svg" },
    generation: { duration_ms: 0 },
  };
  expect(
    (
      await fx.request("/v1/renders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "expired",
        },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(410);
  expect(fx.seen).toHaveLength(0);
  const freshBody = { ...body, generated_at: new Date().toISOString() };
  const fresh = (await (
    await fx.request("/v1/renders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "fresh",
      },
      body: JSON.stringify(freshBody),
    })
  ).json()) as Run;
  await fx.service.runner.idle();
  const completed = fx.service.runs.get(fresh.id, "a");
  const artifact = completed?.artifacts[0];
  if (!artifact) throw new Error("Missing imported artifact");
  const filename = join(fx.directory, "artifacts", artifact.id);
  await rename(filename, `${filename}.saved`);
  await mkdir(filename);
  fx.service.runs.deletionCandidates(Date.now() + 604800000);
  await fx.service.cleanup();
  expect(errors.join("\n")).toContain("retention_delete_failed");
  expect((await fx.request(`/v1/runs/${fresh.id}`)).status).toBe(410);
  await fx.service.close();
  await rm(filename, { recursive: true });
  await rename(`${filename}.saved`, filename);
  const restarted = createService(fx.config);
  cleanups.pop();
  cleanups.push(async () => {
    await restarted.close();
    fx.upstream.stop(true);
    await rm(fx.directory, { recursive: true, force: true });
  });
  await restarted.cleanup();
  expect(await Bun.file(filename).exists()).toBe(false);
  expect(
    (
      await restarted.app.request(`/v1/runs/${fresh.id}`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
    ).status,
  ).toBe(410);
});

test("a retained collection closes and reopens after all query paths have been exercised", async () => {
  const fx = await fixture();
  const client = fx.config.clients.find((item) => item.id === "a");
  if (!client) throw new Error("Missing test client");
  client.retention = { max_items: 20, max_age_seconds: 604800 };
  const bodies = Array.from({ length: 21 }, (_, index) => ({
    text: svg,
    model: "fixture",
    collection_key: "reopen",
    generated_at: new Date(Date.now() - 100000 + index * 1000).toISOString(),
    output: { type: "svg", preview_width: 64 },
    generation: { duration_ms: 1 },
  }));
  const created = await Promise.all(
    bodies.map(async (body, index) => {
      const response = await fx.request("/v1/renders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `reopen-${index}`,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(202);
      return (await response.json()) as Run;
    }),
  );
  await fx.service.runner.idle();
  const survivor = created.at(-1);
  if (!survivor) throw new Error("Missing final task");
  const result = (await (
    await fx.request(`/v1/runs/${survivor.id}`)
  ).json()) as Run;
  expect((await fx.request(result.artifacts[0]?.path ?? "")).status).toBe(200);
  expect(
    (await (await fx.request("/v1/runs?limit=100")).json()).data,
  ).toHaveLength(20);
  await fx.service.cleanup();
  await fx.service.close();
  const restarted = createService(fx.config);
  cleanups.pop();
  cleanups.push(async () => {
    await restarted.close();
    fx.upstream.stop(true);
    await rm(fx.directory, { recursive: true, force: true });
  });
  expect(restarted.runs.get(survivor.id, "a")?.status).toBe("succeeded");
  expect(restarted.runs.list("a", { limit: 100, offset: 0 })).toHaveLength(20);
  expect(fx.seen).toHaveLength(0);
});

process.once("beforeExit", () => logSpy.mockRestore());
