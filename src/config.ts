import { resolve } from "node:path";
import { z } from "zod";
import { protocolSchema, sha256 } from "./schema";

const id = z.string().regex(/^[\w-]{1,80}$/);
const connectionSchema = z.strictObject({
  id,
  protocol: protocolSchema,
  base_url: z.url(),
  api_key_env: z.string().min(1),
  auth: z.enum(["bearer", "x-api-key"]).optional(),
  anthropic_version: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default("2023-06-01"),
  allow_http: z.boolean().default(false),
});
const configSchema = z.strictObject({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(3000),
  data_dir: z.string().default("./data"),
  concurrency: z.number().int().min(1).max(16).default(2),
  queue_limit: z.number().int().min(1).max(10000).default(100),
  generation_timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(1_800_000)
    .default(300_000),
  render_timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
  connections: z.array(connectionSchema).default([]),
  clients: z
    .array(
      z.strictObject({
        id,
        token_env: z.string().min(1),
        connections: z.array(id).default([]),
        allow_render: z.boolean().default(false),
        retention: z
          .strictObject({
            max_items: z.number().int().min(1).max(1000),
            max_age_seconds: z.number().int().min(60).max(31_536_000),
          })
          .optional(),
        expires_at: z.iso.datetime().optional(),
      }),
    )
    .min(1),
});

export type Connection = z.infer<typeof connectionSchema> & {
  api_key: string;
  auth: "bearer" | "x-api-key";
};
export interface Client {
  id: string;
  token_hash: string;
  connections: string[];
  expires_at?: string;
  allow_render: boolean;
  retention?: { max_items: number; max_age_seconds: number };
}
export type Config = Omit<
  z.infer<typeof configSchema>,
  "connections" | "clients"
> & {
  connections: Map<string, Connection>;
  clients: Client[];
  secrets: string[];
};

export function parseConfig(
  input: unknown,
  env: Record<string, string | undefined> = process.env,
): Config {
  const parsed = configSchema.parse(input);
  const connections = new Map<string, Connection>();
  const secrets: string[] = [];
  for (const entry of parsed.connections) {
    if (connections.has(entry.id))
      throw new Error(`Duplicate connection id: ${entry.id}`);
    const url = new URL(entry.base_url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    ) {
      throw new Error(
        `Connection ${entry.id}: base_url must be HTTP(S), without credentials, query or fragment`,
      );
    }
    if (url.protocol === "http:" && !entry.allow_http) {
      throw new Error(
        `Connection ${entry.id}: HTTP requires explicit allow_http for trusted local networks`,
      );
    }
    const secret = env[entry.api_key_env];
    if (!secret || /[\r\n]/.test(secret))
      throw new Error(
        `Missing or invalid environment variable: ${entry.api_key_env}`,
      );
    secrets.push(secret);
    connections.set(entry.id, {
      ...entry,
      base_url: url.toString().replace(/\/$/, ""),
      auth:
        entry.auth ?? (entry.protocol === "anthropic" ? "x-api-key" : "bearer"),
      api_key: secret,
    });
  }
  const clients: Client[] = [];
  for (const entry of parsed.clients) {
    if (!entry.allow_render && entry.connections.length === 0)
      throw new Error(`Client ${entry.id} has no permitted operations`);
    const token = env[entry.token_env];
    if (!token || token.length < 32 || /\s/.test(token)) {
      throw new Error(
        `Environment variable ${entry.token_env} must contain a service token of at least 32 non-whitespace characters`,
      );
    }
    const hash = sha256(token);
    if (
      clients.some(
        (client) => client.id === entry.id || client.token_hash === hash,
      )
    ) {
      throw new Error("Client ids and service tokens must be unique");
    }
    if (entry.connections.some((connection) => !connections.has(connection))) {
      throw new Error(`Client ${entry.id} references an unknown connection`);
    }
    secrets.push(token);
    clients.push({
      id: entry.id,
      token_hash: hash,
      connections: entry.connections,
      expires_at: entry.expires_at,
      allow_render: entry.allow_render,
      retention: entry.retention,
    });
  }
  return {
    ...parsed,
    data_dir: resolve(parsed.data_dir),
    connections,
    clients,
    secrets,
  };
}

export async function loadConfig(): Promise<Config> {
  return parseConfig(
    await Bun.file(process.env.CONFIG_PATH ?? "config.json").json(),
  );
}
