import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChildRunner, ChildRunnerOptions } from "./types.js";
import { classifyFailure } from "./failure.js";

const SHUTDOWN_TIMEOUT_MS = 3000;
const CHILD_INSTRUCTIONS =
  "You are a delegated child agent. Complete the delegated task and return its result to your owner. Collect the results of any children you spawn before your final response; unfinished descendants are cancelled when you finish.";
const childConstruction = new AsyncLocalStorage<boolean>();
const childExecution = new AsyncLocalStorage<AgentSession>();

/**
 * Prevent a discovered copy of this extension from creating a second coordinator in a child.
 */
export function isChildConstruction(): boolean {
  return childConstruction.getStore() === true;
}

/**
 * The actual child session supplies live settings when the SDK context omits them.
 */
export function getChildOwnerSession(): AgentSession | undefined {
  return childExecution.getStore();
}

/**
 * Create a fresh persisted Pi session using the caller's configuration and public provider APIs.
 */
export async function createChildRunner(options: ChildRunnerOptions): Promise<ChildRunner> {
  const { owner } = options;
  const ctx = owner.context;
  const manager = createTranscript(options);
  let session: AgentSession | undefined;
  try {
    options.signal.throwIfAborted();
    const agentDir = getAgentDir();
    const requested = resolveModel(options);
    const settingsManager = SettingsManager.inMemory(owner.settings, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
      refreshOnCreate: false,
      signal: options.signal,
    });
    for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
      const configuration = ctx.modelRegistry.getRegisteredProviderConfig(id);
      if (native) runtime.registerNativeProvider(native);
      else if (configuration) runtime.registerProvider(id, configuration);
    }
    options.signal.throwIfAborted();
    const allowed = new Set([...ctx.tools.map((tool) => tool.name), ...owner.activeTools]);
    for (const tool of options.tools) allowed.add(tool.name);
    const loader = createResourceLoader(options, settingsManager, agentDir);
    await childConstruction.run(true, async () => {
      await loader.reload();
      const loadErrors = loader.getExtensions().errors;
      if (loadErrors.length) {
        recordPrivateFailure(manager, loadErrors[0]!.error, "startup", options.onDiagnostic);
        options.onDiagnostic("extension.failed", {
          category: "extension",
          phase: "startup",
          path: loadErrors[0]!.path,
          hook: "load",
        });
      }
      if (loadErrors.length) throw new Error("The child could not load its configured extensions");
      options.signal.throwIfAborted();
      const created = await createAgentSession({
        cwd: ctx.cwd,
        agentDir,
        modelRuntime: runtime,
        model: requested,
        thinkingLevel: options.input.thinking ?? owner.thinking,
        tools: [...allowed],
        customTools: options.tools.map((tool) => ({
          ...tool,
          execute(...args) {
            const [id, params, signal, onUpdate, context] = args;
            if (!session) throw new Error("The child session has not initialised");
            return childExecution.run(session, () =>
              tool.execute(id, params, signal, onUpdate, context),
            );
          },
        })),
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager,
      });
      session = created.session;
      options.signal.throwIfAborted();
      let initialising = true;
      let initialisationFailed = false;
      await created.session.bindExtensions({
        onError(error) {
          const phase =
            error.event === "session_shutdown" ? "cleanup" : initialising ? "startup" : "model";
          recordPrivateFailure(manager, error.error, phase, options.onDiagnostic);
          options.onDiagnostic(phase === "cleanup" ? "cleanup.failed" : "extension.failed", {
            category: phase === "cleanup" ? "cleanup" : "extension",
            phase,
            path: error.extensionPath,
            hook: error.event,
          });
          if (initialising) initialisationFailed = true;
        },
      });
      initialising = false;
      const recreated = new Set(created.session.getAllTools().map((tool) => tool.name));
      const missing = owner.inheritedTools.filter(
        (tool) =>
          allowed.has(tool.name) &&
          tool.sourceInfo.path.startsWith("<") &&
          !recreated.has(tool.name),
      );
      if (missing.length)
        throw new Error(
          `Child cannot recreate inline SDK tools: ${missing.map((tool) => tool.name).join(", ")}. Load these tools from a configured file extension.`,
        );
      created.session.setActiveToolsByName(owner.activeTools);
      if (initialisationFailed) throw new Error("A child extension failed during initialisation");
      options.signal.throwIfAborted();
    });
    const child = session;
    if (!child) throw new Error("Pi did not create the child session");
    const transcriptPath = child.sessionManager.getSessionFile();
    if (!transcriptPath) throw new Error("Pi did not create a persistent child transcript");
    let closed = false;
    let output = "";
    let unsubscribe: (() => void) | undefined;
    return {
      model: child.model
        ? `${child.model.provider}/${child.model.id}`
        : `${requested.provider}/${requested.id}`,
      thinking: child.thinkingLevel,
      transcriptPath,
      currentOutput: () => output,
      async run(prompt) {
        output = "";
        const result: {
          lastAssistant?: Extract<AgentSessionEvent, { type: "message_end" }>["message"];
        } = {};
        unsubscribe = child.subscribe((event) => {
          if (event.type === "message_start" && event.message.role === "assistant") output = "";
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            output += event.assistantMessageEvent.delta;
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            result.lastAssistant = event.message;
            output = event.message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
          }
          options.onEvent(event);
        });
        try {
          options.signal.throwIfAborted();
          await child.prompt(prompt);
          const lastAssistant = result.lastAssistant;
          if (!lastAssistant || lastAssistant.role !== "assistant") {
            return { output: "", error: "The child finished without an assistant response" };
          }
          if (lastAssistant.stopReason === "error") {
            return {
              output,
              error: lastAssistant.errorMessage || "The child model request failed",
              failure: classifyFailure(
                lastAssistant.errorMessage,
                "model",
                lastAssistant.diagnostics,
              ),
            };
          }
          if (lastAssistant.stopReason === "aborted") return { output, aborted: true };
          if (lastAssistant.stopReason === "length") {
            return output
              ? { output, truncated: true }
              : {
                  output,
                  error: "The child reached its output limit without a response",
                  truncated: true,
                };
          }
          return { output };
        } catch (err) {
          recordPrivateFailure(manager, err, "model", options.onDiagnostic);
          throw err;
        } finally {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      },
      abort: () => child.abort(),
      async close() {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = undefined;
        await closeSession(child);
      },
    };
  } catch (err) {
    recordPrivateFailure(manager, err, "startup", options.onDiagnostic);
    if (session) {
      try {
        await closeSession(session);
      } catch {
        options.onDiagnostic("cleanup.failed", {
          category: "cleanup",
          phase: "cleanup",
        });
      }
    }
    throw err;
  }
}

/**
 * Allocate the native transcript before model/resource startup so early failures retain an
 * identity.
 */
function createTranscript(options: ChildRunnerOptions): SessionManager {
  const ctx = options.owner.context;
  let manager = SessionManager.create(ctx.cwd, options.transcriptDirectory, {
    parentSession: ctx.sessionManager.getSessionFile(),
  });
  manager.appendCustomEntry("headless-subagents:identity", {
    rootSessionId: options.record.rootSessionId,
    executionId: options.record.executionId,
    agentId: options.record.id,
    parentAgentId: options.record.parentAgentId,
  });
  const nativeTranscript = manager.getSessionFile();
  if (!nativeTranscript) throw new Error("Pi did not create a persistent child transcript");
  const entries = [manager.getHeader(), ...manager.getEntries()];
  writeFileSync(nativeTranscript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  manager = SessionManager.open(nativeTranscript, options.transcriptDirectory);
  chmodSync(nativeTranscript, 0o600);
  options.onTranscript(nativeTranscript);
  return manager;
}

/**
 * Reconstruct authorised file resources and built-in tool extensions in the parent's trust root.
 */
function createResourceLoader(
  options: ChildRunnerOptions,
  settingsManager: SettingsManager,
  agentDir: string,
): DefaultResourceLoader {
  const ctx = options.owner.context;
  const noExtensions = process.argv.some((value) => value === "--no-extensions" || value === "-ne");
  const factories: NonNullable<
    ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]
  > = [];
  if (!noExtensions) {
    factories.push(
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      {
        name: "tool-search",
        factory: createToolSearchExtension(),
        builtin: true,
        replaceable: true,
      },
    );
    if (!process.argv.includes("--no-mcp")) {
      factories.push({
        name: "mcp",
        factory: createMcpExtension(),
        builtin: true,
        replaceable: true,
      });
    }
  }
  return new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    extensionFactories: factories,
    additionalExtensionPaths: cliPaths("--extension", "-e"),
    additionalSkillPaths: cliPaths("--skill", "-s"),
    noExtensions,
    noSkills: process.argv.some((value) => value === "--no-skills" || value === "-ns"),
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => `${ctx.getSystemPrompt()}\n\n${CHILD_INSTRUCTIONS}`,
    appendSystemPromptOverride: () => [],
    extensionsOverride: (result) => ({
      ...result,
      extensions: result.extensions.filter((extension) => !extension.tools.has("spawn_agent")),
    }),
  });
}

/**
 * Validate an exact available provider/model selection without fuzzy or provider fallbacks.
 */
function resolveModel(options: ChildRunnerOptions) {
  const ctx = options.owner.context;
  if (!options.input.model) {
    if (!ctx.model) throw new Error("The parent session has no model to inherit");
    return ctx.model;
  }
  const separator = options.input.model.indexOf("/");
  if (separator < 1 || separator === options.input.model.length - 1) {
    throw new Error("Model must be an exact provider/model identifier");
  }
  const provider = options.input.model.slice(0, separator);
  const id = options.input.model.slice(separator + 1);
  const model = ctx.modelRegistry
    .getAvailable()
    .find((candidate) => candidate.provider === provider && candidate.id === id);
  if (!model) throw new Error(`Model is not available: ${options.input.model}`);
  return model;
}

/**
 * Always dispose after bounded extension shutdown, including a hung extension hook.
 */
async function closeSession(session: AgentSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([
        session.abort(),
        session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }),
      ]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }).then(() => {
        throw new Error("Child extension shutdown timed out");
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    session.dispose();
  }
}

/**
 * Explicit CLI resources are authorised inputs that are absent from the merged settings snapshot.
 */
function cliPaths(...flags: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index]!;
    const equal = argument.indexOf("=");
    const flag = equal < 0 ? argument : argument.slice(0, equal);
    if (!flags.includes(flag)) continue;
    const value = equal < 0 ? process.argv[++index] : argument.slice(equal + 1);
    if (value) paths.push(value);
  }
  return paths;
}

/**
 * A preflight failure can precede every conversation message; retain its detail only in Pi's
 * private transcript.
 */
function recordPrivateFailure(
  manager: SessionManager,
  value: unknown,
  phase: "startup" | "model" | "cleanup",
  onDiagnostic: ChildRunnerOptions["onDiagnostic"],
): void {
  try {
    manager.appendCustomEntry("headless-subagents:failure", {
      phase,
      message: value instanceof Error ? value.message : String(value),
    });
  } catch {
    onDiagnostic("persistence.failed", { category: "persistence", phase: "persistence" });
  }
}
