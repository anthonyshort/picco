import { tool, type PluginContext, type ToolContext } from "@picco-agent/core";
import { z } from "zod";
import { createBrowserStore } from "./store.js";
import { createCheckRunner } from "./runner.js";
import { ensureTarget } from "./supervisor.js";
import { createUpdateDelivery } from "./updates.js";
import { createAtlasClient } from "./atlas.js";
import { stopAtlasRun } from "./cancellation.js";
import {
  BrowserRequestSchema,
  browserCaller,
  type BrowserChecks,
  type BrowserChecksOptions,
  type BrowserJob,
} from "./types.js";

export {
  BrowserRequestSchema,
  BrowserPlanSchema,
  BrowserEvidenceSchema,
  BrowserResultSchema,
  BrowserJobSchema,
} from "./types.js";
export type {
  BrowserChecks,
  BrowserChecksOptions,
  BrowserRequest,
  BrowserPlan,
  BrowserEvidence,
  BrowserArtifact,
  BrowserResult,
  BrowserJob,
  BrowserProfile,
} from "./types.js";

/**
 * Answer bounded browser questions with durable jobs and plugin-owned Picco sessions.
 */
export function browserChecks(opts: BrowserChecksOptions): BrowserChecks {
  z.strictObject({
    url: z.url(),
    token: z.string().min(1),
    workflow: z.string().min(1).max(200),
    resultNode: z.string().min(1).optional(),
    fetch: z.function().optional(),
  }).parse(opts.atlas);
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(300000)
    .parse(opts.timeoutMs ?? 300000);
  z.number()
    .int()
    .min(1)
    .max(30000)
    .parse(opts.pollIntervalMs ?? 2000);
  for (const profile of Object.values(opts.profiles)) {
    if (!profile.origins.length || !profile.instructions.trim())
      throw new Error("Browser profiles require allowed origins and instructions");
    for (const origin of profile.origins) {
      const url = new URL(origin);
      if (url.origin !== origin || !["https:", "http:"].includes(url.protocol))
        throw new Error("Configure canonical HTTP origins for browser environments");
    }
  }
  let store: ReturnType<typeof createBrowserStore> | undefined;
  let runner: ReturnType<typeof createCheckRunner> | undefined;
  let delivery: ReturnType<typeof createUpdateDelivery> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: { id: string; controller: AbortController; work: Promise<void> } | undefined;
  let ctx: PluginContext | undefined;
  let stopped = true;
  let healthy = true;

  function state() {
    if (!store || stopped) throw new Error("Browser-check plugin is not started");
    return store;
  }

  function owner(context: ToolContext) {
    if (
      context.caller.kind === "session" &&
      !(opts.allowedSources ?? []).includes(context.caller.ref.source)
    )
      throw new Error("This session may not manage browser checks");
    return browserCaller(context);
  }

  function checkOwner(id: string, caller: string) {
    const job = state().get(id);
    if (caller !== "host" && job.owner !== caller)
      throw new Error("Browser check belongs to another caller");
    return job;
  }

  function submit(input: z.input<typeof BrowserRequestSchema>, caller: string) {
    const service = state();
    if (!healthy)
      throw new Error("Browser admissions stopped after a persistence or cleanup failure");
    const request = BrowserRequestSchema.parse(input);
    const profile = opts.profiles[request.profile];
    if (!profile) throw new Error("Unknown browser environment profile");
    if (request.url) ensureTarget(request.url, profile);
    const job = service.submit(caller, request, timeoutMs);
    queueMicrotask(tick);
    return job;
  }

  async function cancel(id: string, caller: string): Promise<BrowserJob> {
    const job = checkOwner(id, caller);
    if (active?.id === id) {
      active.controller.abort("cancelled");
      await active.work;
      return cancel(id, caller);
    }
    if (job.state === "queued")
      return state().update(id, { state: "cancelled", remoteStopped: true });
    if (job.remote && job.remoteStopped !== true) {
      const atlas = createAtlasClient(opts.atlas);
      const remoteStopped = await stopAtlasRun(atlas, job.remote.runId);
      return state().update(id, { state: "cancelled", remoteStopped });
    }
    return job;
  }

  function tick() {
    if (stopped || !store || !runner || !healthy) return;
    void delivery?.tick().catch(() => {
      healthy = false;
      ctx?.logger.error("Browser update state could not be persisted; admissions stopped");
    });
    if (active) return;
    const job = store
      .list()
      .find((item) =>
        ["queued", "launching", "running", "assessing", "preparing"].includes(item.state),
      );
    if (!job) return;
    const controller = new AbortController();
    const work = runner(job.id, controller.signal, () => stopped)
      .catch(() => {
        healthy = false;
        ctx?.logger.error("Browser job persistence or cleanup failed; admissions stopped", {
          id: job.id,
        });
      })
      .finally(() => {
        active = undefined;
        if (!stopped) queueMicrotask(tick);
      });
    active = { id: job.id, controller, work };
  }

  return {
    name: "browser-checks",
    tools: [
      tool({
        name: "browser_check_start",
        description:
          "Start one concrete browser question in the background. Reuse requestKey for the same submission; acknowledgement is not a test result.",
        input: BrowserRequestSchema,
        execute(input, context) {
          return JSON.stringify(submit(input, owner(context)));
        },
      }),
      tool({
        name: "browser_check_status",
        description:
          "Read a browser check's saved progress, answer and evidence. Does not start or repeat work.",
        input: z.strictObject({ id: z.uuid() }),
        execute({ id }, context) {
          return JSON.stringify(checkOwner(id, owner(context)));
        },
      }),
      tool({
        name: "browser_check_cancel",
        description:
          "Request cancellation of a browser check. Inspect remoteStopped before assuming Atlas work ended.",
        input: z.strictObject({ id: z.uuid() }),
        async execute({ id }, context) {
          return JSON.stringify(await cancel(id, owner(context)));
        },
      }),
    ],
    checks: {
      start: (request) => submit(request, "host"),
      status: (id) => state().get(id),
      cancel: (id) => cancel(id, "host"),
    },
    start(context) {
      ctx = context;
      store = createBrowserStore(context.filePath("jobs.sqlite"));
      runner = createCheckRunner(context, opts, store);
      delivery = createUpdateDelivery(store, opts.onUpdate, context.logger);
      stopped = false;
      healthy = true;
      // Adopt only saved launch identities; a new request is never manufactured on restart.
      for (const job of store.list()) {
        if (job.state === "uncertain" && job.plan && !job.remote && job.deadline > Date.now())
          store.update(job.id, { state: "launching" });
      }
      timer = setInterval(tick, Math.min(opts.pollIntervalMs ?? 2000, 1000));
      timer.unref();
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      active?.controller.abort("shutdown");
      await active?.work;
      await delivery?.stop();
      store?.close();
      store = undefined;
    },
  };
}
