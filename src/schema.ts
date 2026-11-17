import { z } from "zod";

export const protocolSchema = z.enum([
  "openai-chat",
  "openai-responses",
  "anthropic",
]);
export type Protocol = z.infer<typeof protocolSchema>;

export const runRequestSchema = z.strictObject({
  connection_id: z.string().regex(/^[\w-]{1,80}$/),
  model: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  system_prompt: z.string().max(100_000).optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  output: z.strictObject({
    type: z.literal("svg"),
    preview_width: z.number().int().min(64).max(2048).default(1024),
  }),
  metadata: z.record(z.string().max(80), z.string().max(1000)).default({}),
});
export type RunRequest = z.infer<typeof runRequestSchema>;
export const renderRequestSchema = z.strictObject({
  text: z.string().max(4 * 1024 * 1024),
  model: z.string().min(1).max(200),
  prompt: z.string().max(100_000).default(""),
  system_prompt: z.string().max(100_000).optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  collection_key: z.string().regex(/^[\w:.-]{1,160}$/),
  generated_at: z.iso.datetime(),
  output: runRequestSchema.shape.output,
  metadata: runRequestSchema.shape.metadata,
  generation: z.strictObject({
    model: z.string().max(200).optional(),
    finish_reason: z.string().max(100).optional(),
    response_status: z.string().max(100).optional(),
    incomplete_details: z.unknown().optional(),
    usage: z.unknown().optional(),
    request_id: z.string().max(200).optional(),
    duration_ms: z.number().nonnegative().max(1_800_000),
    incomplete: z.boolean().optional(),
  }),
});
export type Stage =
  | "request"
  | "generation"
  | "extraction"
  | "rendering"
  | "storage";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface Diagnostic {
  code: string;
  stage: Stage;
  message: string;
  details?: Record<string, unknown>;
  causes?: { name: string; message: string; code?: string; stack?: string }[];
}

export interface GenerationResult {
  text: string;
  model?: string;
  finish_reason?: string;
  response_status?: string;
  incomplete_details?: unknown;
  usage?: unknown;
  request_id?: string;
  duration_ms: number;
  incomplete?: boolean;
}

export interface Artifact {
  id: string;
  run_id: string;
  type: "raw_text" | "svg" | "png";
  content_type: string;
  size: number;
  sha256: string;
  path: string;
}

export interface Run {
  id: string;
  client_id: string;
  status: RunStatus;
  stage: Stage;
  request: RunRequest;
  connection: {
    protocol: Protocol;
    base_url: string;
    anthropic_version?: string;
    auth: string;
  };
  prompt_sha256: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  generation?: Omit<GenerationResult, "text">;
  error?: Diagnostic;
  artifacts: Artifact[];
  source?: "provided";
  input_text?: string;
  collection_key?: string;
  generated_at?: string;
  expires_at?: number;
  retention_max_items?: number;
  deleted_at?: string;
}

export function publicRun(run: Run): Omit<Run, "input_text"> {
  const { input_text: _text, ...result } = run;
  return result;
}

const tokenLimit = z.number().int().min(1).max(1_000_000);
const shared = {
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
};
const parameterSchemas = {
  "openai-chat": z.strictObject({
    ...shared,
    max_tokens: tokenLimit.optional(),
    max_completion_tokens: tokenLimit.optional(),
    seed: z.number().int().optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    reasoning_effort: z.string().min(1).max(32).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
  }),
  "openai-responses": z.strictObject({
    ...shared,
    max_output_tokens: tokenLimit.optional(),
    reasoning: z
      .strictObject({
        effort: z.string().min(1).max(32).optional(),
        summary: z.enum(["auto", "concise", "detailed"]).optional(),
      })
      .optional(),
    text: z
      .strictObject({ verbosity: z.enum(["low", "medium", "high"]) })
      .optional(),
  }),
  anthropic: z.strictObject({
    temperature: z.number().min(0).max(1).optional(),
    top_p: shared.top_p,
    top_k: z.number().int().min(0).optional(),
    max_tokens: tokenLimit,
    stop_sequences: z.array(z.string()).max(20).optional(),
    thinking: z
      .discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("enabled"),
          budget_tokens: z.number().int().min(1024).max(1_000_000),
        }),
        z.strictObject({ type: z.literal("disabled") }),
        z.strictObject({ type: z.literal("adaptive") }),
      ])
      .optional(),
    output_config: z
      .strictObject({ effort: z.string().min(1).max(32) })
      .optional(),
  }),
};

export function validateParameters(
  protocol: Protocol,
  parameters: RunRequest["parameters"],
) {
  return parameterSchemas[protocol].safeParse(parameters);
}

export const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  model: z.string().max(200).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
});

export const sha256 = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
