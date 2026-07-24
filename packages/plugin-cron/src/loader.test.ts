import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type AgentJobConfig, JobLoader, type ScriptJobConfig } from "./loader.js";

let tmpDir: string;
let jobDir: string;
let loader: JobLoader;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "loader-test-"));
  jobDir = path.join(tmpDir, "jobs");
  loader = new JobLoader(jobDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function agentJob(overrides: Partial<AgentJobConfig> = {}): AgentJobConfig {
  return {
    id: "daily",
    type: "agent",
    description: "A daily job",
    schedule: "0 0 9 * * *",
    enabled: true,
    prompt: "Do the thing",
    ...overrides,
  };
}

function scriptJob(overrides: Partial<ScriptJobConfig> = {}): ScriptJobConfig {
  return {
    id: "backup",
    type: "script",
    description: "A backup job",
    schedule: "0 */5 * * * *",
    enabled: true,
    command: "echo hi",
    ...overrides,
  };
}

describe("JobLoader constructor", () => {
  test("creates the jobs directory it was given", async () => {
    expect(existsSync(jobDir)).toBe(true);
    expect(loader.jobDir).toBe(jobDir);
  });
});

describe("refresh", () => {
  test("loads valid yaml configs keyed by id", async () => {
    await loader.save(agentJob({ id: "one" }));
    await loader.save(scriptJob({ id: "two" }));

    const fresh = new JobLoader(jobDir);
    const configs = await fresh.refresh();

    expect([...configs.keys()].sort()).toEqual(["one", "two"]);
    expect(configs.get("one")?.type).toBe("agent");
    expect(configs.get("two")?.type).toBe("script");
  });

  test("skips files missing required fields without throwing", async () => {
    await writeFile(path.join(jobDir, "no-id.yaml"), 'schedule: "0 0 9 * * *"\ntype: script\n');
    await writeFile(path.join(jobDir, "no-schedule.yaml"), "id: x\ntype: script\n");
    await loader.save(scriptJob({ id: "good" }));

    const configs = await loader.refresh();
    expect([...configs.keys()]).toEqual(["good"]);
  });

  test("skips files with invalid schedules", async () => {
    await writeFile(
      path.join(jobDir, "interval.yaml"),
      "id: interval\nschedule: 5m\ntype: script\ncommand: echo hi\n",
    );
    await loader.save(scriptJob({ id: "good" }));

    const configs = await loader.refresh();
    expect([...configs.keys()]).toEqual(["good"]);
  });

  test("skips a file whose id could escape the jobs directory", async () => {
    await writeFile(
      path.join(jobDir, "evil.yaml"),
      'id: ../../evil\nschedule: "0 0 9 * * *"\ntype: script\ncommand: echo hi\ndescription: d\nenabled: true\n',
    );
    await loader.save(scriptJob({ id: "good" }));

    const configs = await loader.refresh();
    expect([...configs.keys()]).toEqual(["good"]);
  });

  test("ignores non-yaml files", async () => {
    await writeFile(path.join(jobDir, "notes.txt"), 'id: nope\nschedule: "0 0 9 * * *"\n');
    await loader.save(scriptJob({ id: "good" }));

    const configs = await loader.refresh();
    expect([...configs.keys()]).toEqual(["good"]);
  });

  test("suspends all jobs and logs an error when the jobs directory disappears", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await rm(loader.jobDir, { recursive: true, force: true });
      const configs = await loader.refresh();

      expect(configs.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("jobs suspended"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("save", () => {
  test("writes a yaml file and updates the cache", async () => {
    await loader.save(agentJob({ id: "writes" }));

    const onDisk = await readFile(path.join(jobDir, "writes.yaml"), "utf-8");
    expect(onDisk).toContain("id: writes");
    expect(loader.get("writes")?.id).toBe("writes");
  });

  test("rejects ids that are not alphanumeric/hyphen/underscore before writing", async () => {
    await expect(loader.save(agentJob({ id: "bad id!" }))).rejects.toThrow(/alphanumeric/);

    expect(loader.get("bad id!")).toBeUndefined();
    const files = await readdir(jobDir);
    expect(files).toEqual([]);
  });

  test("rejects an invalid schedule before writing", async () => {
    await expect(loader.save(agentJob({ id: "bad-sched", schedule: "5m" }))).rejects.toThrow(
      /Invalid schedule/,
    );

    const files = await readdir(jobDir);
    expect(files).toEqual([]);
  });
});

describe("update({ enabled })", () => {
  test("flips the enabled flag on disk and in cache", async () => {
    await loader.save(scriptJob({ id: "toggle", enabled: true }));

    const updated = await loader.update("toggle", { enabled: false });
    expect(updated.enabled).toBe(false);
    expect(loader.get("toggle")?.enabled).toBe(false);

    const onDisk = await readFile(path.join(jobDir, "toggle.yaml"), "utf-8");
    expect(onDisk).toContain("enabled: false");
  });
});

describe("remove", () => {
  test("deletes the file and the cache entry", async () => {
    await loader.save(scriptJob({ id: "gone" }));
    await loader.remove("gone");

    expect(loader.get("gone")).toBeUndefined();
    const files = await readdir(jobDir);
    expect(files).toEqual([]);
  });

  test("throws when the job is not cached — an unvetted id never reaches unlink", async () => {
    await expect(loader.remove("never")).rejects.toThrow(/not found/);
    await expect(loader.remove("../../etc/passwd")).rejects.toThrow(/not found/);
  });
});

describe("update", () => {
  test("throws when the config is not cached", async () => {
    await expect(loader.update("missing", { description: "new desc" })).rejects.toThrow(
      /not found/,
    );
  });

  test("merges partial fields and persists to disk", async () => {
    await loader.save(
      agentJob({ id: "updatable", description: "original", schedule: "0 */5 * * * *" }),
    );

    const updated = await loader.update("updatable", {
      description: "updated desc",
      schedule: "0 */10 * * * *",
    });

    expect(updated.description).toBe("updated desc");
    expect(updated.schedule).toBe("0 */10 * * * *");
    // Fields not in partial are preserved
    expect(updated.type).toBe("agent");
    if (updated.type === "agent") {
      expect(updated.prompt).toBe("Do the thing");
    }
    expect(updated.enabled).toBe(true);

    // Cache is updated
    expect(loader.get("updatable")?.description).toBe("updated desc");

    // Disk is updated
    const onDisk = await readFile(path.join(jobDir, "updatable.yaml"), "utf-8");
    expect(onDisk).toContain("updated desc");
    expect(onDisk).toContain("0 */10 * * * *");
  });

  test("updates only the fields provided", async () => {
    await loader.save(
      scriptJob({
        id: "partial",
        description: "orig",
        schedule: "0 */5 * * * *",
        command: "echo a",
      }),
    );

    await loader.update("partial", { description: "changed" });

    const config = loader.get("partial");
    expect(config?.description).toBe("changed");
    expect(config?.schedule).toBe("0 */5 * * * *");
    if (config?.type === "script") {
      expect(config.command).toBe("echo a");
    }
  });

  test("strips a field that does not belong to the job's type instead of persisting it", async () => {
    await loader.save(scriptJob({ id: "strict" }));

    await loader.update("strict", { prompt: "not a script field" });

    expect(loader.get("strict")).not.toHaveProperty("prompt");
    const onDisk = await readFile(path.join(jobDir, "strict.yaml"), "utf-8");
    expect(onDisk).not.toContain("prompt");
  });

  test("rejects an invalid schedule without touching disk or cache", async () => {
    await loader.save(scriptJob({ id: "keep", schedule: "0 */5 * * * *" }));

    await expect(loader.update("keep", { schedule: "10m" })).rejects.toThrow(/Invalid schedule/);

    expect(loader.get("keep")?.schedule).toBe("0 */5 * * * *");
    const onDisk = await readFile(path.join(jobDir, "keep.yaml"), "utf-8");
    expect(onDisk).toContain("0 */5 * * * *");
  });
});
