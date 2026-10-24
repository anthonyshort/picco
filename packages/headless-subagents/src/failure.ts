import { z } from "zod";
import { FailureSchema, type Failure } from "./types.js";

const ErrorShape = z.object({
  code: z.unknown().optional(),
  status: z.number().int().optional(),
  statusCode: z.number().int().optional(),
  message: z.string().optional(),
});
const DiagnosticsSchema = z.array(z.object({ error: ErrorShape.optional() })).max(100);

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
  if (sources.some((source) => source.code === "token_expired")) {
    const status = sources
      .map((source) => source.statusCode ?? source.status)
      .find(
        (candidateStatus) =>
          candidateStatus !== undefined && candidateStatus >= 400 && candidateStatus <= 599,
      );
    return {
      category: "authentication",
      phase,
      code: "token_expired",
      reason: "credentials_expired",
      ...(status !== undefined ? { statusCode: status } : {}),
    };
  }
  for (const source of sources) {
    const status =
      source.statusCode ??
      source.status ??
      (typeof source.code === "number" ? source.code : undefined);
    if (status !== undefined && status >= 400 && status <= 599) return fromStatus(status, phase);
  }
  const codes = sources.flatMap((source) => {
    const code = FailureSchema.shape.code.safeParse(source.code);
    return code.success && code.data ? [code.data] : [];
  });
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
  const message =
    typeof value === "string" ? value : parsed.success ? parsed.data.message : undefined;
  if (message) {
    if (
      /^Authentication failed for ".+"\. Credentials may have expired or network is unavailable\./.test(
        message,
      )
    ) {
      return { category: "authentication", phase, reason: "credentials_unavailable" };
    }
    if (
      /^(?:API key auth failed for provider|OAuth refresh failed for|Credential store (?:read|modify) failed for) [^:]+(?::|$)/.test(
        message,
      )
    ) {
      return { category: "authentication", phase, reason: "credentials_unavailable" };
    }
    if (/^No API key (?:found for|for) /.test(message)) {
      return { category: "authentication", phase, reason: "credentials_unavailable" };
    }
    // Pi's HTTP provider adapters flatten status-prefixed SDK errors into assistant errorMessage.
    const status = /^(?:HTTP )?(401|403|429|5\d\d)(?:\s|:|$)/.exec(message);
    if (status) return fromStatus(Number(status[1]), phase);
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
