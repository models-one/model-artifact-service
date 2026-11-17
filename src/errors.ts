import type { Diagnostic, Stage } from "./schema";

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly stage: Stage,
    public readonly status = 500,
    public readonly details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ServiceError";
  }
}

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: string[]) {
    this.secrets = [
      ...new Set(
        secrets.flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]),
      ),
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  knownSecrets(input: string): string {
    let text = input;
    for (const secret of this.secrets)
      text = text.replaceAll(secret, "[REDACTED]");
    return text;
  }

  text(input: string, depth = 0): string {
    const text = this.knownSecrets(input);
    // Decode JSON before redaction so escaped keys/values cannot hide secrets.
    if (/^\s*[\[{]/.test(text)) {
      try {
        return JSON.stringify(this.value(JSON.parse(text), depth + 1));
      } catch {
        /* Non-JSON diagnostics use the bounded text fallback below. */
      }
    }
    return text
      .replace(
        /((?:proxy-authorization|authorization|set-cookie|cookie)\s*:\s*)[^\r\n]+/gi,
        "$1[REDACTED]",
      )
      .replace(
        /((?:api[_-]?key|(?:access|refresh|id)[_-]?token|authorization|password|secret|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi,
        "$1[REDACTED]",
      );
  }

  value<T>(value: T, depth = 0): T {
    if (depth > 32) return "[TRUNCATED]" as T;
    if (typeof value === "string") return this.text(value, depth) as T;
    if (Array.isArray(value))
      return value.map((item) => this.value(item, depth + 1)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.knownSecrets(key),
          /^(authorization|proxy[_-]?authorization|x-api-key|api[_-]?key|(?:access|refresh|id)[_-]?token|token|password|secret|client[_-]?secret|private[_-]?key|cookie|set-cookie|session(?:[_-]?id)?)$/i.test(
            key,
          )
            ? "[REDACTED]"
            : this.value(item, depth + 1),
        ]),
      ) as T;
    }
    return value;
  }
}

export function diagnose(
  error: unknown,
  stage: Stage,
  redactor: Redactor,
): Diagnostic {
  const detail: Diagnostic =
    error instanceof ServiceError
      ? {
          code: error.code,
          stage: error.stage,
          message: error.message,
          details: error.details,
        }
      : {
          code: "internal_error",
          stage,
          message: error instanceof Error ? error.message : String(error),
        };
  const causes: NonNullable<Diagnostic["causes"]> = [];
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = "code" in current ? String(current.code) : undefined;
    causes.push({
      name: current.name,
      message: current.message,
      code,
      stack: current.stack?.slice(0, 6000),
    });
    current = current.cause;
  }
  if (causes.length) detail.causes = causes;
  const sanitized = redactor.value(detail);
  const body = sanitized.details?.response_body;
  if (typeof body === "string" && body.length > 32000) {
    sanitized.details = {
      ...sanitized.details,
      response_body: body.slice(0, 32000),
      response_body_truncated: true,
    };
  }
  return sanitized;
}

export async function readLimited(
  response: Response | Request,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ServiceError(
          "body_too_large",
          `Body exceeds ${limit} bytes`,
          "request",
          413,
          { limit },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
