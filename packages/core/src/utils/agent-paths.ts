import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionRef } from "../types.js";

/**
 * Generate a sortable, unique session id: a filesystem-safe timestamp plus a short random suffix.
 * Example: `2025-07-15T08-00-00-000Z-a1b2c3d4`
 */
export function generateSessionId(): string {
  return `${generateTimestamp()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Generate a filesystem-safe timestamp segment for session keys and paths. Colons and dots are
 * replaced with dashes so the value is valid as a path segment. Example:
 * `2025-07-15T08-00-00-000Z`
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Resolves the on-disk directories an agent uses. All paths hang off `root` (`<dataDir>/<name>`).
 */
export interface AgentPaths {
  /**
   * The agent's data root: `<dataDir>/<name>`.
   */
  root: string;

  /**
   * Working directory for a source-owned session, keyed by `source`/`key`. Both are joined verbatim
   * and trusted to be path-safe: a `key` with `/` nests, and `..` could escape `root`. Sources
   * today supply safe keys (numeric ids, controlled job ids); sanitise here if that ever changes.
   */
  sessionCwd(ref: SessionRef): string;

  /**
   * Working directory for a host-initiated run (always under the `host` source).
   */
  runCwd(id: string): string;

  /**
   * Per-plugin storage directory.
   */
  pluginDir(pluginName: string): string;
}

/**
 * Create an `AgentPaths` resolver rooted at `<dataDir>/<name>`.
 */
export function createAgentPaths(dataDir: string, name: string): AgentPaths {
  const root = path.join(dataDir, name);

  return {
    root,
    sessionCwd(ref) {
      return path.join(root, "sessions", ref.source, ref.key);
    },
    runCwd(id) {
      return path.join(root, "sessions", "host", id);
    },
    pluginDir(pluginName) {
      return path.join(root, "plugins", pluginName);
    },
  };
}
