import { randomUUID } from "node:crypto";
import { CronHistory, type CronHistoryOptions } from "./history.js";
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
   * Private persisted history: defaults to 1,000 records, 30 days and 8,192 output characters.
   */
  history?: CronHistoryOptions;
  /**
   * The jobs directory: {jobDir}/*.yaml. Default: the plugin's data directory.
   */
  jobDir?: string;
  /**
   * How often to re-read the jobs directory for external edits. Default: 60s.
   */
  heartbeatMs?: number;
  /**
   * Observe completed runs after their history is persisted. Rejections are logged without changing
   * the recorded execution result. Default: logs through the plugin logger.
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
      const loader = new JobLoader(dir, ctx.logger);

      const onRunComplete =
        options.onRunComplete ??
        ((run: JobRun) => {
          if (run.status === "error") {
            ctx.logger.error(`job ${run.jobId} failed`, run.error);
          } else {
            ctx.logger.log(`job ${run.jobId} completed`, { durationMs: run.durationMs });
          }
        });

      const history = new CronHistory({
        file: ctx.filePath("runs.json"),
        history: options.history,
      });
      const scheduler = new JobScheduler({
        history,
        logger: ctx.logger,
        loader,
        runAgent: async ({ jobId, prompt, model, thinking, timeoutMs, reportExecution }) => {
          const key = `${jobId}/${generateTimestamp()}-${randomUUID()}`;
          try {
            const turn = ctx.sessions.run(key, prompt, {
              timeoutMs: timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
              // The key is unique per run, so this always creates the session — the job's
              // model/thinking overrides land on the fresh pi session. Conditional spreads keep an
              // undefined from clobbering the agent-wide value in the pi merge.
              session: {
                ephemeral: true,
                pi: { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) },
              },
            });
            if (turn.execution) reportExecution?.(turn.execution.id);
            return (await turn).text;
          } finally {
            await ctx.sessions.reset(key);
          }
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
      const scheduler = deps?.scheduler;
      deps = null;
      await scheduler?.stop();
    },
  };
}

export type { JobConfig } from "./loader.js";
export type { JobRun, OnRunComplete } from "./scheduler.js";

export type { CronHistoryOptions, JobRunRecord } from "./history.js";
