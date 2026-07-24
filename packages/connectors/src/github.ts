import type { Connector } from "@picco-agent/identity";

export interface GithubConnectorOptions {
  clientId: string;
  clientSecret: string;
  /**
   * OAuth scopes the connection is granted (e.g. `["repo", "read:org"]`). Required — `repo` means
   * full read/write on the user's repositories, so the caller chooses how much to hand over.
   */
  scopes: string[];
}

/**
 * Create GitHub's hosted MCP connector using a registered OAuth or GitHub App.
 */
export function github(opts: GithubConnectorOptions): Connector {
  return {
    name: "github",
    description: "GitHub — repos, PRs, issues (acts as your account)",
    auth: {
      kind: "oauth",
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: opts.scopes,
    },
    mcp: { url: "https://api.githubcopilot.com/mcp/" },
  };
}
