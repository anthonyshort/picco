/**
 * Cron plugin — scheduler service + the cron_* toolkit.
 *
 * Jobs are YAML files in {jobDir} (agent-writable via cron_add, hot-reloaded by a 60s heartbeat).
 * The plugin keeps no other state: every completed run is reported to `onRunComplete` and then
 * forgotten. Agent jobs run via ctx.sessions.run with a composite key ({jobId}/{timestamp}),
 * creating sessions under sessions/cron/{jobId}/{timestamp}/. Script jobs run through
 * ctx.runtime.exec in the agent's configured runtime.
 */
import { JobLoader } from "./loader.js";
import { JobScheduler, type JobRun, type OnRunComplete } from "./scheduler.js";
import { buildCronTools, type CronDeps } from "./tools.js";
import { generateTimestamp } from "@picco-agent/core";
import type { Plugin, PluginContext } from "@picco-agent/core";

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_AGENT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Configuration for the cron plugin.
 */
export interface CronOptions {
  /**
   * The jobs directory: {jobDir}/*.yaml. Default: the plugin's data directory.
   */
  jobDir?: string;
  /**
   * How often to re-read the jobs directory for external edits. Default: 60s.
   */
  heartbeatMs?: number;
  /**
   * Called after every job run with its outcome (status, output, error). Wire this to your own
   * log/store if you want run history — the plugin keeps no state on disk. May be async; a
   * rejection is logged, never thrown into the run loop. Default: logs through the plugin logger.
   */
  onRunComplete?: OnRunComplete;
}

/**
 * Create the cron plugin: job loader + scheduler service and the cron_* tools.
 */
export function cron(options: CronOptions = {}): Plugin {
  let deps: CronDeps | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  return {
    name: "cron",

    tools: buildCronTools(() => {
      if (!deps) throw new Error("cron plugin is not started");
      return deps;
    }),

    async start(ctx: PluginContext) {
      const dir = options.jobDir ?? ctx.filePath();
      const loader = new JobLoader(dir);

      const onRunComplete =
        options.onRunComplete ??
        ((run: JobRun) => {
          if (run.status === "error") {
            ctx.logger.error(`job ${run.jobId} failed`, run.error);
          } else {
            ctx.logger.log(`job ${run.jobId} completed`, { durationMs: run.durationMs });
          }
        });

      const scheduler = new JobScheduler({
        loader,
        runAgent: async ({ jobId, prompt, model, thinking, timeoutMs }) => {
          const key = `${jobId}/${generateTimestamp()}`;
          const { text } = await ctx.sessions.run(key, prompt, {
            timeoutMs: timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
            // The key is unique per run, so this always creates the session — the job's
            // model/thinking overrides land on the fresh pi session. Conditional spreads keep an
            // undefined from clobbering the agent-wide value in the pi merge.
            session: { pi: { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) } },
          });
          return text;
        },
        runScript: ({ command, timeoutMs }) => ctx.runtime.exec(command, { timeoutMs }),
        onRunComplete,
      });
      deps = { scheduler };

      // Initial load + heartbeat: picks up YAML edits and agent-added
      // jobs without a restart.
      const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      await scheduler.reload().catch((err) => ctx.logger.error("failed to load jobs", err));
      heartbeat = setInterval(() => {
        scheduler.reload().catch((err) => ctx.logger.error("heartbeat tick failed", err));
      }, heartbeatMs);
      ctx.logger.log("started", { dir, heartbeat: heartbeatMs });
    },

    async stop() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      deps?.scheduler.stopAllTimers();
      deps = null;
    },
  };
}

export type { JobConfig } from "./loader.js";
export type { JobRun, OnRunComplete } from "./scheduler.js";
