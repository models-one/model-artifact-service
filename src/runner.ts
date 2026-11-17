import { generate } from "./adapters";
import type { Config } from "./config";
import { diagnose, type Redactor, ServiceError } from "./errors";
import { type ArtifactRenderer, extractSvg } from "./renderer";
import type { Run } from "./schema";
import type { ArtifactStore, RunStore } from "./store";

export class Runner {
  private readonly active = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private stopping = false;

  constructor(
    private readonly config: Config,
    private readonly runs: RunStore,
    private readonly artifacts: ArtifactStore,
    private readonly renderer: ArtifactRenderer,
    private readonly redactor: Redactor,
  ) {}

  wake(): void {
    while (!this.stopping && this.active.size < this.config.concurrency) {
      const run = this.runs.pending();
      if (!run) return;
      run.status = "running";
      run.started_at ??= new Date().toISOString();
      this.runs.save(run);
      const execution = this.execute(run).finally(() => {
        this.active.delete(execution);
        this.wake();
      });
      this.active.add(execution);
    }
  }

  private async execute(run: Run): Promise<void> {
    try {
      const client = this.config.clients.find(
        (item) => item.id === run.client_id,
      );
      if (
        !client ||
        (client.expires_at && Date.parse(client.expires_at) <= Date.now()) ||
        (run.source === "provided"
          ? !client.allow_render
          : !client.connections.includes(run.request.connection_id))
      ) {
        throw new ServiceError(
          "authorization_changed",
          "Caller no longer has access to this connection",
          "request",
          403,
        );
      }
      let text: string;
      const existing = run.artifacts.find(
        (artifact) => artifact.type === "raw_text",
      );
      if (run.expires_at !== undefined && run.expires_at <= Date.now()) {
        throw new ServiceError(
          "expired",
          "Provided output is past its retention period",
          "storage",
          410,
        );
      }
      if (run.source === "provided" && !existing) {
        if (run.input_text === undefined)
          throw new ServiceError(
            "missing_input",
            "Persisted render input is missing",
            "storage",
            500,
          );
        text = this.redactor.knownSecrets(run.input_text);
        const raw = await this.artifacts.put(run.id, "raw_text", text);
        run.artifacts.push(raw);
        run.input_text = undefined;
        this.runs.save(run, raw);
      } else if (run.generation && existing) {
        text = await this.artifacts.read(existing).text();
      } else {
        const connection = this.config.connections.get(
          run.request.connection_id,
        );
        if (
          !connection ||
          connection.base_url !== run.connection.base_url ||
          connection.protocol !== run.connection.protocol ||
          connection.auth !== run.connection.auth ||
          connection.anthropic_version !== run.connection.anthropic_version
        ) {
          throw new ServiceError(
            "connection_changed",
            "Connection configuration changed since submission; submit a new task",
            "generation",
            409,
          );
        }
        run.stage = "generation";
        this.runs.save(run);
        const result = await generate(
          connection,
          run.request,
          AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(this.config.generation_timeout_ms),
          ]),
        );
        text = this.redactor.knownSecrets(result.text);
        const { text: _text, ...generation } = result;
        run.generation = this.redactor.value(generation);
        const raw = await this.artifacts.put(run.id, "raw_text", text);
        run.artifacts.push(raw);
        this.runs.save(run, raw);
      }
      if (run.generation?.incomplete) {
        throw new ServiceError(
          "generation_incomplete",
          "Generation did not finish normally; partial output is preserved",
          "generation",
          422,
          {
            finish_reason: run.generation.finish_reason,
            response_status: run.generation.response_status,
            incomplete_details: run.generation.incomplete_details,
            upstream_request_id: run.generation.request_id,
          },
        );
      }
      run.stage = "extraction";
      this.runs.save(run);
      const svg = extractSvg(text);
      if (!run.artifacts.some((artifact) => artifact.type === "svg")) {
        const source = await this.artifacts.put(run.id, "svg", svg);
        run.artifacts.push(source);
        this.runs.save(run, source);
      }
      run.stage = "rendering";
      this.runs.save(run);
      if (!run.artifacts.some((artifact) => artifact.type === "png")) {
        const png = await this.renderer.render(
          svg,
          run.request.output.preview_width,
          AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(this.config.render_timeout_ms),
          ]),
        );
        const preview = await this.artifacts.put(run.id, "png", png);
        run.artifacts.push(preview);
        this.runs.save(run, preview);
      }
      run.status = "succeeded";
    } catch (error) {
      if (
        this.abort.signal.aborted &&
        (run.source === "provided" ||
          run.artifacts.some((artifact) => artifact.type === "raw_text"))
      ) {
        run.status = "queued";
        run.error = undefined;
        this.runs.save(run);
        return;
      }
      run.status = "failed";
      run.error = diagnose(error, run.stage, this.redactor);
      console.error(
        JSON.stringify({
          event: "run_failed",
          run_id: run.id,
          client_id: run.client_id,
          error: run.error,
        }),
      );
    }
    run.finished_at = new Date().toISOString();
    this.runs.complete(run);
  }

  async idle(): Promise<void> {
    while (this.active.size) await Promise.all(this.active);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.idle();
  }
}
