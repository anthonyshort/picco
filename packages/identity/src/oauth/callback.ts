import { createServer, type Server, type ServerResponse } from "node:http";
import type { Logger } from "@picco-agent/core";

/**
 * Default loopback port used for OAuth callbacks.
 */
export const DEFAULT_CALLBACK_PORT = 8976;

/**
 * Loopback callback listener dependencies.
 */
export interface OAuthCallbackListenerOptions {
  callbackUrl: string;
  port?: number;
  complete(state: string, code: string): Promise<boolean>;
  logger: Logger;
}

/**
 * Receive OAuth callbacks and complete retained authorizations.
 */
export class OAuthCallbackListener {
  private httpServer: Server | null = null;
  private boundPort = 0;

  constructor(private readonly opts: OAuthCallbackListenerOptions) {}

  get port(): number {
    return this.boundPort || (this.opts.port ?? DEFAULT_CALLBACK_PORT);
  }

  async start(): Promise<void> {
    if (this.httpServer) throw new Error("OAuth callback listener already started");
    const route = new URL(this.opts.callbackUrl).pathname;
    const server = createServer((request, response) => {
      // A raw socket can send an unparseable request-target, which throws inside respond.
      void this.respond(request.method, request.url, route, response).catch(() => {
        if (!response.headersSent) response.writeHead(400).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? DEFAULT_CALLBACK_PORT, "127.0.0.1", () => resolve());
    });
    this.httpServer = server;
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : 0;
    this.opts.logger.log("oauth callback listening", {
      port: this.port,
      route,
      publicUrl: this.opts.callbackUrl,
    });
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  private async respond(
    method: string | undefined,
    requestUrl: string | undefined,
    route: string,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(requestUrl ?? "/", "http://localhost");
    if (method !== "GET" || url.pathname !== route) {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(page("Connection refused", `The provider said: ${error}. You can close this tab.`));
      return;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code || !(await this.opts.complete(state, code).catch(() => false))) {
      response
        .writeHead(400, { "content-type": "text/html" })
        .end(page("Link expired", "This sign-in link is no longer valid. Send /connect again."));
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Connected", "You can close this tab and return to the chat."));
  }
}

/**
 * Build the small browser result page returned by the callback listener. Escapes both fields —
 * `detail` can carry the provider's error string, which arrives on the untrusted query string.
 */
function page(title: string, detail: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`
  );
}

/**
 * Escape text for safe interpolation into HTML content.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
