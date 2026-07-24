import * as z from "zod";
import { errorMessage, markdownTable, THINKING_LEVELS, tool, type Tool } from "@picco-agent/core";
import type { JobConfigUpdate } from "./loader.js";
import type { JobScheduler } from "./scheduler.js";

export const CronAddSchema = z.object({
  id: z.string().describe("Unique job id (alphanumeric, hyphens, underscores only)"),
  description: z.string().describe("Job description"),
  schedule: z.string().describe('6-field cron expression (seconds first), e.g. "0 0 9 * * *"'),
  type: z.enum(["agent", "script"]),
  prompt: z.string().optional().describe("Agent prompt (required for agent jobs)"),
  command: z.string().optional().describe("Shell command (required for script jobs)"),
  timeout: z.number().optional().describe("Timeout in seconds (scripts default 300, agents 600)"),
  model: z.string().optional().describe("Model override for agent jobs"),
  thinking: z.enum(THINKING_LEVELS).optional().describe("Thinking level for agent jobs"),
});

export type CronAddParams = z.infer<typeof CronAddSchema>;

export const CronUpdateSchema = z.object({
  id: z.string().describe("Job id to update"),
  description: z.string().optional().describe("New job description"),
  schedule: z
    .string()
    .optional()
    .describe('New schedule: 6-field cron expression, e.g. "0 0 9 * * *"'),
  enabled: z.boolean().optional().describe("Enable or disable the job"),
  prompt: z.string().optional().describe("New agent prompt (agent jobs only)"),
  command: z.string().optional().describe("New shell command (script jobs only)"),
  timeout: z.number().optional().describe("New timeout in seconds"),
  model: z.string().optional().describe("New model override (agent jobs only)"),
  thinking: z.enum(THINKING_LEVELS).optional().describe("New thinking level (agent jobs only)"),
});

export type CronUpdateParams = z.infer<typeof CronUpdateSchema>;

/**
 * Render all loaded jobs as a markdown table.
 */
export function cronList(scheduler: JobScheduler): string {
  const jobs = scheduler.listJobs();
  if (jobs.length === 0) {
    return "No cron jobs loaded.";
  }

  return markdownTable(
    ["Name", "Type", "Schedule", "Status", "Last Run", "Runs"],
    jobs.map((j) => [
      j.id,
      j.type,
      j.schedule,
      j.enabled ? "enabled" : "disabled",
      j.lastRun ?? "never",
      String(j.fireCount),
    ]),
  );
}

/**
 * Add a new agent or script job (enabled immediately).
 */
export async function cronAdd(scheduler: JobScheduler, params: CronAddParams): Promise<string> {
  try {
    switch (params.type) {
      case "agent":
        if (!params.prompt) return 'Agent jobs require a "prompt".';
        await scheduler.addJob({
          id: params.id,
          type: "agent",
          schedule: params.schedule,
          description: params.description,
          prompt: params.prompt,
          enabled: true,
          timeout: params.timeout,
          model: params.model,
          thinking: params.thinking,
        });
        break;
      case "script":
        if (!params.command) return 'Script jobs require a "command".';
        await scheduler.addJob({
          id: params.id,
          type: "script",
          schedule: params.schedule,
          description: params.description,
          command: params.command,
          timeout: params.timeout,
          enabled: true,
        });
        break;
      default:
        throw new Error(`Unknown job type: ${(params as { type: string }).type}`);
    }
    return `Job "${params.id}" added successfully.`;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Update only the fields the model supplied on an existing job.
 */
export async function cronUpdate(
  scheduler: JobScheduler,
  params: CronUpdateParams,
): Promise<string> {
  try {
    // Only provided fields may enter the partial — an undefined value would survive the loader's
    // merge and clobber the existing field.
    const partial: JobConfigUpdate = {};
    if (params.description !== undefined) partial.description = params.description;
    if (params.schedule !== undefined) partial.schedule = params.schedule;
    if (params.enabled !== undefined) partial.enabled = params.enabled;
    if (params.prompt !== undefined) partial.prompt = params.prompt;
    if (params.command !== undefined) partial.command = params.command;
    if (params.timeout !== undefined) partial.timeout = params.timeout;
    if (params.model !== undefined) partial.model = params.model;
    if (params.thinking !== undefined) partial.thinking = params.thinking;

    return await scheduler.updateJob(params.id, partial);
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Dependencies injected per tool call so the scheduler is available after start.
 */
export interface CronDeps {
  scheduler: JobScheduler;
}

/**
 * Build the five cron_* tool definitions. Enable/disable is a `cron_update { enabled }` call; run
 * outcomes go to CronOptions.onRunComplete (the plugin keeps no history). Deps are resolved per
 * call — the scheduler exists only after the plugin starts, but Plugin.tools is collected by
 * createAgent() before that.
 */
export function buildCronTools(deps: () => CronDeps): Tool[] {
  return [
    tool({
      name: "cron_list",
      description: "List all scheduled cron jobs with their status, schedule, and type.",
      input: z.object({}),
      execute: () => cronList(deps().scheduler),
    }),
    tool({
      name: "cron_add",
      description:
        "Add a new scheduled cron job. Agent jobs require 'prompt', script jobs require 'command'.",
      input: CronAddSchema,
      execute: (args) => cronAdd(deps().scheduler, args),
    }),
    tool({
      name: "cron_update",
      description:
        "Update fields on an existing cron job (including enabled/disabled). " +
        "Only the fields provided are changed; omitted fields are left untouched.",
      input: CronUpdateSchema,
      execute: (args) => cronUpdate(deps().scheduler, args),
    }),
    tool({
      name: "cron_remove",
      description: "Remove a scheduled cron job by id. Deletes the job file and stops the job.",
      input: z.object({ id: z.string().describe("Job id to remove") }),
      execute: ({ id }) => deps().scheduler.removeJob(id).catch(errorMessage),
    }),
    tool({
      name: "cron_run",
      description:
        "Trigger a cron job to run immediately, bypassing its schedule. " +
        "Runs in the background.",
      input: z.object({ id: z.string().describe("Job id to run") }),
      execute: ({ id }) => deps().scheduler.triggerJob(id),
    }),
  ];
}
