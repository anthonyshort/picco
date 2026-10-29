import * as z from "zod";

/**
 * Host-owned credentials and an injectable HTTP transport; neither is exposed to the model.
 */
export interface GithubToolsOptions {
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
}

/**
 * The response schema is selected by the operation that owns the resource.
 */
interface GithubRequest<Response> {
  path: string;
  method: string;
  schema: z.ZodType<Response>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Read and preparation failures are known not to have changed GitHub.
 */
export function rejected(reason: string) {
  return { status: "rejected" as const, reason };
}

/**
 * An unconfirmed write must be inspected before another attempt.
 */
export function uncertain() {
  return {
    status: "uncertain" as const,
    message: "GitHub may have accepted the write. Inspect GitHub before retrying.",
  };
}

/**
 * Perform one request without retries and classify failures by whether a write was sent.
 */
export async function requestGithub<Response>(
  options: GithubToolsOptions,
  input: GithubRequest<Response>,
) {
  const token = await resolveToken(options.token);
  if (!token) return rejected("GitHub credentials unavailable");
  if (input.signal?.aborted) return rejected("GitHub request cancelled before sending");
  try {
    const response = await (options.fetch ?? fetch)(`https://api.github.com${input.path}`, {
      method: input.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2026-03-10",
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      redirect: "error",
      signal: input.signal,
    });
    if (response.status >= 500 || response.status === 408)
      return input.method === "GET" ? rejected("GitHub lookup failed") : uncertain();
    if (!response.ok) return rejected(`GitHub request rejected (${response.status})`);
    return { status: "confirmed" as const, data: input.schema.parse(await response.json()) };
  } catch {
    return input.method === "GET" ? rejected("GitHub lookup failed") : uncertain();
  }
}

/**
 * Credential callback diagnostics may contain secrets and stay outside tool results.
 */
async function resolveToken(value: GithubToolsOptions["token"]): Promise<string | undefined> {
  try {
    return (typeof value === "function" ? await value() : value).trim() || undefined;
  } catch {
    return undefined;
  }
}
