import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import type { Client, Config } from "./config";
import { diagnose, Redactor, readLimited, ServiceError } from "./errors";
import { openapi } from "./openapi";
import { SvgRenderer } from "./renderer";
import { Runner } from "./runner";
import {
  listQuerySchema,
  publicRun,
  type Run,
  renderRequestSchema,
  runRequestSchema,
  sha256,
  validateParameters,
} from "./schema";
import { LocalArtifactStore, RunStore } from "./store";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export function createService(config: Config) {
  const redactor = new Redactor(config.secrets);
  const runs = new RunStore(config.data_dir);
  const artifacts = new LocalArtifactStore(join(config.data_dir, "artifacts"));
  const runner = new Runner(
    config,
    runs,
    artifacts,
    new SvgRenderer(),
    redactor,
  );
  const app = new Hono<{ Variables: { client: Client; requestId: string } }>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/openapi.json", (c) => c.json(openapi));
  app.use("/v1/*", async (c, next) => {
    const authorization = c.req.header("authorization") ?? "";
    const token = /^Bearer ([^\s]{32,512})$/i.exec(authorization)?.[1];
    const hash = sha256(token ?? "");
    const client = config.clients.find((entry) =>
      timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(entry.token_hash, "hex"),
      ),
    );
    if (
      !token ||
      !client ||
      (client.expires_at && Date.parse(client.expires_at) <= Date.now())
    ) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json(
        {
          error: {
            code: "unauthorized",
            stage: "request",
            message: "Invalid or expired service token",
          },
          request_id: c.get("requestId"),
        },
        401,
      );
    }
    c.set("client", client);
    await next();
  });

  app.post("/v1/runs", async (c) => {
    if (
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      throw new ServiceError(
        "unsupported_content_type",
        "Content-Type must be application/json",
        "request",
        415,
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(await readLimited(c.req.raw, 256 * 1024));
    } catch (cause) {
      if (cause instanceof ServiceError) throw cause;
      throw new ServiceError(
        "invalid_json",
        "Request body is not valid JSON",
        "request",
        400,
        undefined,
        cause,
      );
    }
    const parsed = runRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new ServiceError(
        "invalid_request",
        "Request validation failed",
        "request",
        422,
        { issues: parsed.error.issues },
      );
    const request = parsed.data;
    const client = c.get("client");
    if (!client.connections.includes(request.connection_id))
      throw new ServiceError(
        "connection_forbidden",
        "Connection access denied",
        "request",
        403,
      );
    const connection = config.connections.get(request.connection_id);
    if (!connection)
      throw new ServiceError(
        "connection_unavailable",
        "Connection is unavailable",
        "request",
        503,
      );
    const parameters = validateParameters(
      connection.protocol,
      request.parameters,
    );
    if (!parameters.success)
      throw new ServiceError(
        "invalid_parameters",
        `Parameters are invalid for ${connection.protocol}`,
        "request",
        422,
        { issues: parameters.error.issues },
      );
    const key = c.req.header("Idempotency-Key");
    if (key !== undefined && !/^[\x21-\x7e]{1,200}$/.test(key))
      throw new ServiceError(
        "invalid_idempotency_key",
        "Idempotency-Key must contain 1–200 printable ASCII characters without spaces",
        "request",
        422,
      );
    const hash = sha256(canonicalJson(request));
    if (key) {
      const existing = runs.findIdempotent(client.id, key, hash);
      if (existing) return c.json(redactor.value(existing), 202);
    }
    const run: Run = {
      id: `run_${crypto.randomUUID()}`,
      client_id: client.id,
      status: "queued",
      stage: "request",
      request,
      connection: {
        protocol: connection.protocol,
        base_url: connection.base_url,
        auth: connection.auth,
        anthropic_version: connection.anthropic_version,
      },
      prompt_sha256: sha256(request.prompt),
      created_at: new Date().toISOString(),
      artifacts: [],
    };
    runs.enqueue(run, hash, key, config.queue_limit);
    runner.wake();
    c.header("Location", `/v1/runs/${run.id}`);
    return c.json(redactor.value(run), 202);
  });

  app.get("/v1/capabilities", (c) =>
    c.json({
      render: c.get("client").allow_render,
      retention: c.get("client").retention ?? null,
      protocols: ["openai-chat", "openai-responses", "anthropic"],
    }),
  );

  app.post("/v1/renders", async (c) => {
    const client = c.get("client");
    if (!client.allow_render)
      throw new ServiceError(
        "render_forbidden",
        "Client is not permitted to submit render jobs",
        "request",
        403,
      );
    if (
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw new ServiceError(
        "unsupported_content_type",
        "Content-Type must be application/json",
        "request",
        415,
      );
    let input: unknown;
    try {
      input = JSON.parse(await readLimited(c.req.raw, 8 * 1024 * 1024));
    } catch (cause) {
      if (cause instanceof ServiceError) throw cause;
      throw new ServiceError(
        "invalid_json",
        "Request body is not valid JSON",
        "request",
        400,
        undefined,
        cause,
      );
    }
    const parsed = renderRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new ServiceError(
        "invalid_request",
        "Render request validation failed",
        "request",
        422,
        { issues: parsed.error.issues },
      );
    const request = parsed.data;
    const generatedAt = Date.parse(request.generated_at);
    const expiresAt = client.retention
      ? generatedAt + client.retention.max_age_seconds * 1000
      : undefined;
    if (generatedAt > Date.now() + 60_000)
      throw new ServiceError(
        "invalid_generated_at",
        "Generation time cannot be in the future",
        "request",
        422,
      );
    if (expiresAt !== undefined && expiresAt <= Date.now())
      throw new ServiceError(
        "expired",
        "Output is already past its retention period",
        "storage",
        410,
      );
    const key = c.req.header("Idempotency-Key");
    if (!key || !/^[\x21-\x7e]{1,200}$/.test(key))
      throw new ServiceError(
        "invalid_idempotency_key",
        "Render jobs require a 1–200 character Idempotency-Key",
        "request",
        422,
      );
    const hash = sha256(canonicalJson({ kind: "render", ...request }));
    const existing = runs.findIdempotent(client.id, key, hash);
    if (existing) return c.json(redactor.value(publicRun(existing)), 202);
    const run: Run = {
      id: `run_${crypto.randomUUID()}`,
      client_id: client.id,
      status: "queued",
      stage: "extraction",
      source: "provided",
      request: {
        connection_id: "",
        model: request.model,
        prompt: request.prompt,
        system_prompt: request.system_prompt,
        parameters: request.parameters,
        output: request.output,
        metadata: request.metadata,
      },
      connection: { protocol: "openai-chat", base_url: "", auth: "none" },
      input_text: redactor.knownSecrets(request.text),
      generation: redactor.value(request.generation),
      collection_key: request.collection_key,
      generated_at: new Date(generatedAt).toISOString(),
      expires_at: expiresAt,
      retention_max_items: client.retention?.max_items,
      prompt_sha256: sha256(request.prompt),
      created_at: new Date().toISOString(),
      artifacts: [],
    };
    runs.enqueue(run, hash, key, config.queue_limit);
    runner.wake();
    c.header("Location", `/v1/runs/${run.id}`);
    return c.json(redactor.value(publicRun(run)), 202);
  });

  app.get("/v1/runs", (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      throw new ServiceError(
        "invalid_query",
        "Invalid history query",
        "request",
        422,
        { issues: parsed.error.issues },
      );
    return c.json(
      redactor.value({
        data: runs.list(c.get("client").id, parsed.data).map(publicRun),
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      }),
    );
  });
  app.get("/v1/runs/:id", (c) => {
    const run = runs.get(c.req.param("id"), c.get("client").id);
    if (!run)
      throw new ServiceError("not_found", "Task not found", "request", 404);
    return c.json(redactor.value(publicRun(run)));
  });
  app.get("/v1/artifacts/:id", (c) => {
    const artifact = runs.artifact(c.req.param("id"), c.get("client").id);
    if (!artifact)
      throw new ServiceError("not_found", "Artifact not found", "request", 404);
    const file = artifacts.read(artifact);
    if (file.size !== artifact.size)
      throw new ServiceError(
        "artifact_unavailable",
        "Artifact is missing or its size changed",
        "storage",
        500,
        { artifact_id: artifact.id },
      );
    const extension = artifact.type === "raw_text" ? "txt" : artifact.type;
    c.header("Content-Type", artifact.content_type);
    c.header(
      "Content-Disposition",
      `${artifact.type === "png" ? "inline" : "attachment"}; filename="${artifact.id}.${extension}"`,
    );
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return c.body(file);
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          stage: "request",
          message: "Route not found",
        },
        request_id: c.get("requestId"),
      },
      404,
    ),
  );
  app.onError((error, c) => {
    const diagnostic = diagnose(error, "request", redactor);
    const status = error instanceof ServiceError ? error.status : 500;
    if (status === 429) c.header("Retry-After", "5");
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: "request_failed",
          request_id: c.get("requestId"),
          error: diagnostic,
        }),
      );
    return new Response(
      JSON.stringify({ error: diagnostic, request_id: c.get("requestId") }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": c.get("requestId"),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(status === 429 ? { "Retry-After": "5" } : {}),
        },
      },
    );
  });

  runs.recover();
  runs.reconcileRetention();
  let cleanupRunning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupRunning ??= (async () => {
      for (const run of runs.deletionCandidates()) {
        try {
          for (const artifact of run.artifacts)
            await artifacts.delete(artifact);
          runs.finishDelete(run);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "retention_delete_failed",
              run_id: run.id,
              error: diagnose(error, "storage", redactor),
            }),
          );
        }
      }
      runs.purgeTombstones();
      await artifacts.removeOrphans((id) => runs.artifactExists(id));
    })()
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "retention_cleanup_failed",
            error: diagnose(error, "storage", redactor),
          }),
        );
      })
      .finally(() => {
        cleanupRunning = undefined;
      });
    return cleanupRunning;
  };
  const cleanupTimer = setInterval(() => {
    void cleanup();
  }, 60_000);
  cleanupTimer.unref();
  void cleanup();
  runner.wake();
  return {
    app,
    runner,
    runs,
    cleanup,
    async close() {
      clearInterval(cleanupTimer);
      await runner.stop();
      await cleanup();
      runs.close();
    },
  };
}
