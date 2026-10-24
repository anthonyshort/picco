import { z } from "zod";

const CATEGORIES = [
  "authentication",
  "permission",
  "rate_limit",
  "provider_unavailable",
  "network",
  "context_limit",
  "output_limit",
  "timeout",
  "cancelled",
  "limit",
  "protocol",
  "runtime",
  "extension",
  "cleanup",
  "persistence",
  "unknown",
] as const;
const PHASES = [
  "startup",
  "model",
  "tool",
  "compaction",
  "cleanup",
  "persistence",
  "protocol",
] as const;
const KNOWN_CODES = [
  "auth",
  "oauth",
  "token_expired",
  "provider",
  "stream",
  "model_source",
  "model_validation",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
] as const;
const ErrorShape = z.object({
  code: z.unknown().optional(),
  status: z.number().int().optional(),
  statusCode: z.number().int().optional(),
  message: z.string().optional(),
});
const DiagnosticsSchema = z.array(z.object({ error: ErrorShape.optional() })).max(100);

/**
 * Selected operational failure fields; source messages remain private.
 */
export const FailureSchema = z.object({
  category: z.enum(CATEGORIES),
  phase: z.enum(PHASES),
  code: z.enum(KNOWN_CODES).optional(),
  statusCode: z.number().int().min(400).max(599).optional(),
  reason: z
    .enum([
      "authentication_rejected",
      "credentials_unavailable",
      "credentials_expired",
      "command_not_found",
      "dependency_unavailable",
      "worker_exited",
    ])
    .optional(),
});
export type Failure = z.infer<typeof FailureSchema>;

/**
 * Select operational failure evidence without forwarding provider messages or attached objects.
 */
export function classifyFailure(
  value: unknown,
  phase: Failure["phase"],
  diagnostics?: unknown,
): Failure {
  const parsed = ErrorShape.safeParse(value);
  const diagnostic = DiagnosticsSchema.safeParse(diagnostics);
  const sources = [
    ...(diagnostic.success
      ? diagnostic.data.flatMap((item) => (item.error ? [item.error] : []))
      : []),
    ...(parsed.success ? [parsed.data] : []),
  ];
  const statusCode = sources
    .map(
      (source) =>
        source.statusCode ??
        source.status ??
        (typeof source.code === "number" ? source.code : undefined),
    )
    .find((status) => status !== undefined && status >= 400 && status <= 599);
  const codes = sources.flatMap((source) => {
    const code = FailureSchema.shape.code.safeParse(source.code);
    return code.success && code.data ? [code.data] : [];
  });
  if (codes.includes("token_expired"))
    return {
      category: "authentication",
      phase,
      code: "token_expired",
      reason: "credentials_expired",
      ...(statusCode !== undefined ? { statusCode } : {}),
    };
  if (statusCode !== undefined) return fromStatus(statusCode, phase);
  const message =
    typeof value === "string" ? value : parsed.success ? parsed.data.message : undefined;
  const messageStatus = message?.match(/^(?:HTTP )?(401|403|429|5\d\d)(?:\s|:|$)/);
  if (messageStatus) return fromStatus(Number(messageStatus[1]), phase);
  for (const code of codes) {
    switch (code) {
      case "auth":
      case "oauth":
        return { category: "authentication", phase, code, reason: "credentials_unavailable" };
      case "ECONNRESET":
      case "ECONNREFUSED":
      case "ETIMEDOUT":
      case "ENOTFOUND":
        return { category: "network", phase, code };
    }
  }
  if (message) {
    if (
      /^API key auth failed for provider [^:\r\n]+: Authentication failed for "[^"\r\n]+"\. Credentials may have expired or network is unavailable\./.test(
        message,
      )
    ) {
      return { category: "authentication", phase, reason: "credentials_unavailable" };
    }
    if (
      /^Authentication failed for ".+"\. Credentials may have expired or network is unavailable\./.test(
        message,
      )
    ) {
      return { category: "authentication", phase, reason: "credentials_unavailable" };
    }
    if (/^No API key (?:found for|for) /.test(message)) {
      return { category: "authentication", phase, reason: "credentials_unavailable" };
    }
  }
  return { category: "unknown", phase, ...(codes[0] ? { code: codes[0] } : {}) };
}

/**
 * HTTP status explains rejection or availability; 401 alone does not prove credential expiry.
 */
function fromStatus(statusCode: number, phase: Failure["phase"]): Failure {
  if (statusCode === 401)
    return { category: "authentication", phase, statusCode, reason: "authentication_rejected" };
  if (statusCode === 403) return { category: "permission", phase, statusCode };
  if (statusCode === 429) return { category: "rate_limit", phase, statusCode };
  return { category: statusCode >= 500 ? "provider_unavailable" : "unknown", phase, statusCode };
}
