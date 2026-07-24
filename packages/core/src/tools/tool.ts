import type * as z from "zod";
import type { Logger, SessionIdentity, SessionRef } from "../types.js";

/**
 * Structurally compatible with MCP content blocks — no SDK dependency.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } };

/**
 * What a tool's `execute` returns: a bare string (the common case) or MCP content blocks for rich
 * results (images, resources, mixed).
 */
export type ToolResult = string | { content: ContentBlock[] };

/**
 * One of this agent's sessions, calling a tool over the bridge.
 */
export type SessionCaller = { kind: "session"; ref: SessionRef };

/**
 * Host code calling a tool directly, outside any session.
 */
export type HostCaller = { kind: "host" };

/**
 * Who invoked a tool: one of this agent's sessions, or host code calling directly.
 */
export type Caller = SessionCaller | HostCaller;

/**
 * Everything a tool's `execute` receives besides its validated input: who is calling, a logger, and
 * (connector tools only) the caller's resolved credential.
 */
export interface ToolContext {
  /**
   * Structured logger for use inside the tool.
   */
  logger: Logger;
  /**
   * Who called: one of this agent's sessions, or host code.
   */
  caller: Caller;
  /**
   * The person behind the calling session's turn — the session's sticky current-user pin, resolved
   * per call. Absent for host callers, for sessions whose turns never carried a user (cron), and
   * before any attributed turn dequeues.
   */
  user?: SessionIdentity;
  /**
   * CONNECTOR TOOLS ONLY: the current sender's credential, resolved per call and injected by the
   * identity plugin's wrapper. Absent from every other tool — credentials never reach the plugin
   * tool surface.
   */
  token?: string;
}

/**
 * A tool the agent can call: a Zod-validated input schema plus an `execute` that runs it. Served to
 * sessions over the loopback bridge, and callable by host code.
 */
export interface Tool<Input extends z.ZodType = z.ZodType> {
  /**
   * Snake_case, unique across the agent.
   */
  name: string;
  /**
   * Written for the model — say when to use it, not just what it does.
   */
  description: string;
  /**
   * Zod schema for the tool's arguments — the single source of truth for the input shape. `execute`
   * receives `z.infer<Input>`, and the bridge publishes this schema's JSON Schema to the session.
   */
  input: Input;
  /**
   * Run the tool with validated input and the call context; return a string or content blocks.
   */
  execute(input: z.infer<Input>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/**
 * Define a tool. Identity at runtime; exists to pin `execute`'s input type to the schema's inferred
 * type.
 */
export function tool<Input extends z.ZodType>(def: Tool<Input>): Tool<Input> {
  return def;
}
