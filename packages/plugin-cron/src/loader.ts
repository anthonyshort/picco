import { mkdirSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { createLogger, THINKING_LEVELS } from "@picco-agent/core";
import { assertValidSchedule, validateCronExpression } from "./schedule.js";

/**
 * Job ids become file names (`<id>.yaml` in the jobs directory) — the pattern blocks path
 * separators, so an id can never escape the directory.
 */
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const JOB_ID_MESSAGE = "Job name must be alphanumeric (hyphens and underscores allowed).";

const BaseJobConfigSchema = z.object({
  id: z.string().regex(JOB_ID_PATTERN, JOB_ID_MESSAGE),
  description: z.string(),
  schedule: z.string(),
  enabled: z.boolean(),
});

const AgentJobConfigSchema = BaseJobConfigSchema.extend({
  type: z.literal("agent"),
  prompt: z.string(),
  timeout: z.number().optional(),
  model: z.string().nullable().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
});

const ScriptJobConfigSchema = BaseJobConfigSchema.extend({
  type: z.literal("script"),
  command: z.string(),
  timeout: z.number().optional(),
});

/**
 * A job file's contents. The schema is the single source of truth — both write paths parse through
 * it, so only schema-clean YAML ever lands on disk.
 */
export const JobConfigSchema = z.discriminatedUnion("type", [
  AgentJobConfigSchema,
  ScriptJobConfigSchema,
]);

/**
 * Agent job — runs a prompt through the session runner.
 */
export type AgentJobConfig = z.infer<typeof AgentJobConfigSchema>;

/**
 * Script job — runs a shell command in the agent runtime.
 */
export type ScriptJobConfig = z.infer<typeof ScriptJobConfigSchema>;

/**
 * Union of all supported job configuration types.
 */
export type JobConfig = z.infer<typeof JobConfigSchema>;

/**
 * Flat partial across both job types, for updates that don't change the discriminant. Derived from
 * the canonical types so it can't drift.
 */
export type JobConfigUpdate = Partial<
  Omit<AgentJobConfig, "id" | "type"> & Omit<ScriptJobConfig, "id" | "type">
>;

const logger = createLogger("job-loader");

/**
 * Loads job configs from YAML files.
 */
export class JobLoader {
  public readonly jobDir: string;

  private configs = new Map<string, JobConfig>();

  constructor(jobDir: string) {
    this.jobDir = jobDir;

    mkdirSync(this.jobDir, { recursive: true });
  }

  /**
   * Read all YAML job files from disk and populate the in-memory cache. Replaces any previously
   * cached configs. Returns the cache. Invalid files are skipped with a warning — never a throw, so
   * one bad file can't abort a heartbeat reload for every job after it.
   */
  async refresh(): Promise<ReadonlyMap<string, JobConfig>> {
    const configs = new Map<string, JobConfig>();

    try {
      const files = (await readdir(this.jobDir)).filter(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
      );

      for (const file of files) {
        try {
          const content = await readFile(path.join(this.jobDir, file), "utf-8");
          const parsed = yamlParse(content);
          const result = JobConfigSchema.safeParse(parsed);

          if (!result.success) {
            logger.warning(`skipping ${file} — invalid job config: ${result.error.message}`);
            continue;
          }

          const config = result.data;

          const check = validateCronExpression(config.schedule);
          if (!check.valid) {
            logger.warning(
              `skipping ${file} — invalid schedule "${config.schedule}": ${check.error}`,
            );
            continue;
          }

          configs.set(config.id, config);
        } catch (err) {
          logger.error(`failed to read ${file}`, err);
        }
      }
    } catch (err) {
      logger.error("failed to read jobs directory — all jobs suspended until the next reload", err);
    }

    this.configs = configs;
    return this.configs;
  }

  /**
   * Get a cached config by id. Returns `undefined` if not loaded.
   */
  get(id: string): JobConfig | undefined {
    return this.configs.get(id);
  }

  /**
   * Get all cached job configs.
   */
  getAll(): ReadonlyMap<string, JobConfig> {
    return this.configs;
  }

  /**
   * Write a new job YAML file. Overwrites if it already exists. Also updates cache. Throws on an
   * invalid id or schedule BEFORE writing — a bad file on disk would otherwise be skipped (with a
   * warning) on every reload forever.
   */
  async save(config: JobConfig): Promise<void> {
    if (!JOB_ID_PATTERN.test(config.id)) {
      throw new Error(JOB_ID_MESSAGE);
    }
    assertValidSchedule(config.schedule);
    const clean = JobConfigSchema.parse(config);
    await writeFile(path.join(this.jobDir, `${config.id}.yaml`), yamlStringify(clean));
    this.configs.set(clean.id, clean);
  }

  /**
   * Delete a job YAML file. Throws if the job is not cached — which also means an id that never
   * round-tripped through the schema can't reach unlink.
   */
  async remove(id: string): Promise<void> {
    if (!this.configs.has(id)) {
      throw new Error(`Job config "${id}" not found`);
    }
    await unlink(path.join(this.jobDir, `${id}.yaml`));
    this.configs.delete(id);
  }

  /**
   * Update selected fields on an existing job file. Only fields present in `partial` are merged;
   * absent fields are left untouched, and fields that don't belong to the job's type are stripped
   * by the schema. Also updates the cache. Throws if the job is not cached.
   */
  async update(id: string, partial: JobConfigUpdate): Promise<JobConfig> {
    const config = this.get(id);
    if (!config) {
      throw new Error(`Job config "${id}" not found`);
    }
    if (partial.schedule !== undefined) assertValidSchedule(partial.schedule);
    const updated = JobConfigSchema.parse({ ...config, ...partial });
    await writeFile(path.join(this.jobDir, `${id}.yaml`), yamlStringify(updated));
    this.configs.set(id, updated);
    return updated;
  }
}
