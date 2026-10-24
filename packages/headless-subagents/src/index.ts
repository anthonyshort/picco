import { readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator } from "./coordinator.js";
import { createChildRunner, getChildOwnerSession, isChildConstruction } from "./sdk.js";
import { createManifestStore } from "./manifest.js";
import {
  ListInputSchema,
  ResultInputSchema,
  SettingsSchema,
  SpawnSchema,
  StopInputSchema,
  type AgentOwner,
  type SubagentSettings,
} from "./types.js";

const CONFIG_FILE = "headless-subagents.json";
const ObjectSchema = z.record(z.string(), z.unknown());

/**
 * Register headless delegation with explicit result collection and persistent all-depth
 * diagnostics.
 */
export default function headlessSubagents(pi: ExtensionAPI): void {
  if (isChildConstruction()) return;
  let coordinator: SubagentCoordinator | undefined;
  let rootSessionId: string | undefined;
  let manifestPath: string | undefined;
  let executionId: string | undefined;
  let forwardingWarning = false;

  function ensureCoordinator(): SubagentCoordinator {
    if (!coordinator) throw new Error("Headless subagents have not initialised for this session");
    return coordinator;
  }

  function owner(id: string | null, ctx: ExtensionToolContext): AgentOwner {
    const child = getChildOwnerSession();
    return {
      id,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
      context: ctx,
      thinking: child?.thinkingLevel ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
      activeTools: child?.getActiveToolNames() ?? pi.getActiveTools(),
      inheritedTools: child?.getAllTools() ?? pi.getAllTools(),
      settings: child?.settingsManager.getSettings() ?? pi.getSettings(),
    };
  }

  function toolsFor(id: string | null): ToolDefinition[] {
    return [
      defineTool(
        "spawn_agent",
        "Start a child task and return its stable ID. Collect its result explicitly with get_agent_result.",
        SpawnSchema,
        async (params, signal, ctx) => {
          signal?.throwIfAborted();
          return { agent: ensureCoordinator().spawn(owner(id, ctx), SpawnSchema.parse(params)) };
        },
      ),
      defineTool(
        "get_agent_result",
        "Inspect an owned child's status and output. Set wait:true to wait; cancelling the wait does not stop the child.",
        ResultInputSchema,
        async (params, signal) => {
          const input = ResultInputSchema.parse(params);
          return ensureCoordinator().result(id, input.agentId, { wait: input.wait, signal });
        },
      ),
      defineTool(
        "stop_agent",
        "Stop an owned child and its descendants, preserving their transcripts and partial output.",
        StopInputSchema,
        async (params) => ({
          agent: await ensureCoordinator().stop(id, StopInputSchema.parse(params).agentId),
        }),
      ),
      defineTool(
        "list_agents",
        "Inspect the session's agent tree and persistent manifest/transcript paths. Observation does not grant control over other branches.",
        ListInputSchema,
        async (params) => {
          const { offset, limit } = ListInputSchema.parse(params);
          const agents = ensureCoordinator().list(id);
          return {
            rootSessionId,
            executionId,
            manifestPath,
            agents: agents.slice(offset, offset + limit),
            pagination: {
              offset,
              limit,
              total: agents.length,
              nextOffset: offset + limit < agents.length ? offset + limit : null,
            },
          };
        },
      ),
    ];
  }

  for (const tool of toolsFor(null)) pi.registerTool(tool);

  pi.on("session_start", async (...args) => {
    const ctx = args[1];
    const nextId = ctx.sessionManager.getSessionId();
    if (coordinator && nextId === rootSessionId) return;
    await coordinator?.close();
    coordinator = undefined;
    rootSessionId = nextId;
    const settings = readSettings(ctx.cwd, ctx.isProjectTrusted());
    const outputDirectory = settings.outputDirectory
      ? path.resolve(ctx.cwd, settings.outputDirectory)
      : path.join(ctx.sessionManager.getSessionDir(), "headless-subagents");
    let store: ReturnType<typeof createManifestStore>;
    try {
      store = createManifestStore(outputDirectory, nextId, ctx.sessionManager.getSessionFile());
    } catch (err) {
      throw new Error("Headless subagents could not initialise the execution manifest", {
        cause: err,
      });
    }
    manifestPath = store.manifestPath;
    executionId = store.executionId;
    pi.appendEntry("headless-subagents:execution", {
      rootSessionId: nextId,
      executionId,
      manifestPath,
    });
    forwardingWarning = false;
    coordinator = new SubagentCoordinator({
      rootSessionId: nextId,
      settings,
      store,
      createRunner: createChildRunner,
      toolsFor,
      onDiagnostic(diagnostic) {
        if (!coordinator || rootSessionId !== diagnostic.rootSessionId) return;
        try {
          pi.appendEntry("headless-subagents:event", diagnostic);
        } catch {
          if (!forwardingWarning) {
            forwardingWarning = true;
            console.error(
              "headless-subagents: parent diagnostic forwarding failed; inspect the execution manifest and native transcripts",
            );
          }
        }
      },
    });
  });

  pi.on("session_shutdown", async () => {
    await coordinator?.close();
    coordinator = undefined;
  });
}

/**
 * Use the Zod contract for both model-facing schemas and boundary validation.
 */
function defineTool(
  name: string,
  description: string,
  schema: z.ZodType,
  execute: (
    params: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionToolContext,
  ) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters: Type.Unsafe(z.toJSONSchema(schema, { io: "input" })),
    async execute(...args) {
      const [, params, signal, , ctx] = args;
      const result = await execute(params, signal, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

/**
 * Project configuration is read only after the parent's trust decision; malformed settings fail
 * visibly.
 */
function readSettings(cwd: string, projectTrusted: boolean): SubagentSettings {
  const global = readObject(path.join(getAgentDir(), CONFIG_FILE));
  const project = projectTrusted ? readObject(path.join(cwd, ".pi", CONFIG_FILE)) : {};
  return SettingsSchema.parse({ ...global, ...project });
}

/**
 * Missing configuration is optional; malformed or inaccessible configuration is a real failure.
 */
function readObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return ObjectSchema.parse(value);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw new Error(`Could not read headless subagent settings: ${file}`, { cause: err });
  }
}

export type { AgentRecord, DiagnosticEvent, SubagentSettings } from "./types.js";
export { DiagnosticEventSchema } from "./types.js";
