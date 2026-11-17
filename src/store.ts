import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError } from "./errors";
import { type Artifact, type Run, sha256 } from "./schema";

export class RunStore {
  private readonly db: Database;
  private readonly statements = new Map<
    string,
    Statement<unknown, SQLQueryBindings[]>
  >();

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "runs.sqlite"), {
      create: true,
      strict: true,
    });
    try {
      // One executor per volume. SQLite holds the exclusive lock until close/crash.
      this.db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, client_id TEXT NOT NULL, status TEXT NOT NULL,
          model TEXT NOT NULL, created_at TEXT NOT NULL,
          idempotency_key TEXT, request_hash TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(client_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS runs_owner_created ON runs(client_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL
        );
      `);
      const columns = new Set(
        (
          this.statement("PRAGMA table_info(runs)").all() as { name: string }[]
        ).map((column) => column.name),
      );
      for (const [name, type] of Object.entries({
        collection_key: "TEXT",
        expires_at: "INTEGER",
        generated_at: "TEXT",
        delete_pending: "INTEGER NOT NULL DEFAULT 0",
        delete_attempted_at: "INTEGER NOT NULL DEFAULT 0",
      })) {
        if (!columns.has(name))
          this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS runs_collection ON runs(client_id, collection_key, status, generated_at); CREATE INDEX IF NOT EXISTS runs_expiry ON runs(expires_at, delete_pending)",
      );
    } catch (error) {
      this.close();
      throw error;
    }
  }

  findIdempotent(clientId: string, key: string, hash: string): Run | undefined {
    const row = this.statement(
      "SELECT data, request_hash FROM runs WHERE client_id = ? AND idempotency_key = ?",
    ).get(clientId, key) as { data: string; request_hash: string } | null;
    if (!row) return;
    if (row.request_hash !== hash)
      throw new ServiceError(
        "idempotency_conflict",
        "Idempotency key was already used with a different request",
        "request",
        409,
      );
    const run: Run = JSON.parse(row.data);
    this.assertAvailable(run);
    return run;
  }

  enqueue(
    run: Run,
    hash: string,
    key: string | undefined,
    limit: number,
  ): void {
    this.db.transaction(() => {
      const { count } = this.statement(
        "SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'running')",
      ).get() as { count: number };
      if (count >= limit)
        throw new ServiceError(
          "queue_full",
          "Task capacity reached; retry later with the same idempotency key",
          "request",
          429,
        );
      this.statement(
        "INSERT INTO runs (id, client_id, status, model, created_at, idempotency_key, request_hash, data, collection_key, expires_at, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        run.id,
        run.client_id,
        run.status,
        run.request.model,
        run.created_at,
        key ?? null,
        hash,
        JSON.stringify(run),
        run.collection_key ?? null,
        run.expires_at ?? null,
        run.generated_at ?? null,
      );
    })();
  }

  save(run: Run, artifact?: Artifact): void {
    this.db.transaction(() => {
      this.statement("UPDATE runs SET status = ?, data = ? WHERE id = ?").run(
        run.status,
        JSON.stringify(run),
        run.id,
      );
      if (artifact)
        this.statement(
          "INSERT INTO artifacts (id, run_id, data) VALUES (?, ?, ?)",
        ).run(artifact.id, artifact.run_id, JSON.stringify(artifact));
    })();
  }

  get(id: string, clientId: string): Run | undefined {
    const row = this.statement(
      "SELECT data FROM runs WHERE id = ? AND client_id = ?",
    ).get(id, clientId) as { data: string } | null;
    if (!row) return;
    const run: Run = JSON.parse(row.data);
    this.assertAvailable(run);
    return run;
  }

  list(
    clientId: string,
    query: { limit: number; offset: number; model?: string; status?: string },
  ): Run[] {
    const rows =
      this.statement(`SELECT data FROM runs WHERE client_id = ? AND delete_pending = 0 AND (expires_at IS NULL OR expires_at > ?)
      AND (? IS NULL OR model = ?) AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(
        clientId,
        Date.now(),
        query.model ?? null,
        query.model ?? null,
        query.status ?? null,
        query.status ?? null,
        query.limit,
        query.offset,
      ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }

  pending(): Run | undefined {
    const row = this.statement(
      "SELECT data FROM runs WHERE status = 'queued' AND delete_pending = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id LIMIT 1",
    ).get(Date.now()) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }

  recover(): void {
    const rows = this.statement(
      "SELECT data FROM runs WHERE status = 'running'",
    ).all() as { data: string }[];
    for (const row of rows) {
      const run: Run = JSON.parse(row.data);
      if (
        run.source === "provided" ||
        (run.generation &&
          run.artifacts.some((item) => item.type === "raw_text"))
      ) {
        run.status = "queued";
      } else {
        run.status = "failed";
        run.finished_at = new Date().toISOString();
        run.error = {
          code: "execution_interrupted",
          stage: run.stage,
          message:
            "Service stopped during execution; upstream may have completed and charged. No automatic generation retry was made.",
        };
      }
      this.save(run);
    }
  }

  artifact(id: string, clientId: string): Artifact | undefined {
    const row = this.statement(
      "SELECT artifacts.data FROM artifacts JOIN runs ON runs.id = artifacts.run_id WHERE artifacts.id = ? AND runs.client_id = ? AND runs.delete_pending = 0 AND (runs.expires_at IS NULL OR runs.expires_at > ?)",
    ).get(id, clientId, Date.now()) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }

  private statement(sql: string): Statement<unknown, SQLQueryBindings[]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare<unknown, SQLQueryBindings[]>(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  close(): void {
    // Own statement lifetimes explicitly. Older Bun query-cache eviction can
    // leave a prepared statement alive after close(), retaining the WAL lock.
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close(true);
  }

  private assertAvailable(run: Run): void {
    if (
      run.deleted_at ||
      (run.expires_at !== undefined && run.expires_at <= Date.now())
    ) {
      throw new ServiceError(
        "expired",
        "Task and artifacts have expired or were removed by retention",
        "storage",
        410,
      );
    }
  }

  pruneCollection(run: Run): void {
    if (
      !run.collection_key ||
      !run.retention_max_items ||
      run.status !== "succeeded"
    )
      return;
    const collection = run.collection_key;
    const maxItems = run.retention_max_items;
    this.db.transaction(() => {
      const excess = this.statement(
        "SELECT data FROM runs WHERE client_id = ? AND collection_key = ? AND status = 'succeeded' AND delete_pending = 0 ORDER BY generated_at DESC, id DESC LIMIT -1 OFFSET ?",
      ).all(run.client_id, collection, maxItems) as {
        data: string;
      }[];
      for (const row of excess) this.markDeleted(JSON.parse(row.data));
    })();
  }

  complete(run: Run): void {
    this.db.transaction(() => {
      this.save(run);
      this.pruneCollection(run);
    })();
  }

  reconcileRetention(): void {
    const collections = this.statement(
      "SELECT client_id, collection_key FROM runs WHERE collection_key IS NOT NULL AND status = 'succeeded' AND delete_pending = 0 GROUP BY client_id, collection_key",
    ).all() as { client_id: string; collection_key: string }[];
    for (const collection of collections) {
      const row = this.statement(
        "SELECT data FROM runs WHERE client_id = ? AND collection_key = ? AND status = 'succeeded' AND delete_pending = 0 ORDER BY generated_at DESC, id DESC LIMIT 1",
      ).get(collection.client_id, collection.collection_key) as {
        data: string;
      } | null;
      if (row) this.pruneCollection(JSON.parse(row.data));
    }
  }

  private markDeleted(run: Run): void {
    run.deleted_at ??= new Date().toISOString();
    run.status = "failed";
    run.input_text = undefined;
    run.request = {
      connection_id: "",
      model: run.request.model,
      prompt: "",
      parameters: {},
      output: run.request.output,
      metadata: {},
    };
    run.generation = undefined;
    run.error = {
      code: "expired",
      stage: "storage",
      message: "Removed by retention",
    };
    this.statement(
      "UPDATE runs SET delete_pending = 1, status = 'failed', data = ? WHERE id = ?",
    ).run(JSON.stringify(run), run.id);
  }

  deletionCandidates(now = Date.now()): Run[] {
    const expired = this.statement(
      "SELECT data FROM runs WHERE expires_at <= ? AND delete_pending = 0 AND status != 'running' LIMIT 100",
    ).all(now) as { data: string }[];
    for (const row of expired) this.markDeleted(JSON.parse(row.data));
    const candidates = (
      this.statement(
        "SELECT data FROM runs WHERE delete_pending = 1 ORDER BY delete_attempted_at, id LIMIT 100",
      ).all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Run);
    // Failed objects rotate behind other candidates instead of starving the
    // remainder of the queue. Record the attempt before touching the filesystem.
    this.db.transaction(() => {
      for (const run of candidates)
        this.statement(
          "UPDATE runs SET delete_attempted_at = ? WHERE id = ?",
        ).run(Date.now(), run.id);
    })();
    return candidates;
  }

  finishDelete(run: Run): void {
    run.artifacts = [];
    this.db.transaction(() => {
      this.statement("DELETE FROM artifacts WHERE run_id = ?").run(run.id);
      this.statement(
        "UPDATE runs SET delete_pending = 2, data = ? WHERE id = ?",
      ).run(JSON.stringify(run), run.id);
    })();
  }

  purgeTombstones(now = Date.now()): void {
    this.statement(
      "DELETE FROM runs WHERE delete_pending = 2 AND expires_at <= ?",
    ).run(now);
  }

  artifactExists(id: string): boolean {
    return !!this.statement("SELECT 1 FROM artifacts WHERE id = ?").get(id);
  }
}

export interface ArtifactStore {
  put(
    runId: string,
    type: Artifact["type"],
    content: string | Uint8Array,
  ): Promise<Artifact>;
  read(artifact: Artifact): Blob;
  delete(artifact: Artifact): Promise<void>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly directory: string) {}

  async put(
    runId: string,
    type: Artifact["type"],
    content: string | Uint8Array,
  ): Promise<Artifact> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = `art_${crypto.randomUUID()}`;
    const path = join(this.directory, id);
    const temporary = `${path}.tmp`;
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    try {
      await Bun.write(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
    } catch (cause) {
      await unlink(temporary).catch(() => {});
      throw new ServiceError(
        "artifact_write_failed",
        "Could not persist artifact",
        "storage",
        500,
        { artifact_id: id },
        cause,
      );
    }
    const mime = {
      raw_text: "text/plain; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
    };
    return {
      id,
      run_id: runId,
      type,
      content_type: mime[type],
      size: bytes.length,
      sha256: sha256(bytes),
      path: `/v1/artifacts/${id}`,
    };
  }

  read(artifact: Artifact): Blob {
    return Bun.file(join(this.directory, artifact.id));
  }

  async delete(artifact: Artifact): Promise<void> {
    try {
      await unlink(join(this.directory, artifact.id));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }

  async removeOrphans(isReferenced: (id: string) => boolean): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    for (const name of names) {
      if (!/^art_[\w-]+(?:\.tmp)?$/.test(name) || isReferenced(name)) continue;
      const path = join(this.directory, name);
      if ((await stat(path)).mtimeMs < Date.now() - 3_600_000)
        await unlink(path);
    }
  }
}
