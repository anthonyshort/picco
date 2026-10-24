import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createManifestStore } from "./manifest.js";
import { AgentRecordSchema } from "./types.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * Every execution gets its own directory beneath a persistent test root.
 */
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "headless-manifest-"));
  directories.push(directory);
  return directory;
}

/**
 * Construct admitted identity before allocating a native transcript.
 */
function record(store: ReturnType<typeof createManifestStore>) {
  return AgentRecordSchema.parse({
    id: "child",
    rootSessionId: "root",
    executionId: store.executionId,
    parentAgentId: null,
    depth: 1,
    status: "starting",
    createdAt: new Date().toISOString(),
    timeoutMs: 1000,
    maxTurns: 5,
    transcriptPath: null,
  });
}

describe("createManifestStore", () => {
  test("persists identity and actual transcript paths with private permissions", () => {
    const store = createManifestStore(fixture(), "root", "/native/root.jsonl");
    const child = record(store);
    store.create(child);
    expect(
      JSON.parse(readFileSync(store.manifestPath, "utf8")).agents[0].transcriptPath,
    ).toBeNull();
    child.transcriptPath = path.join(store.pathsFor(child.id).transcriptDirectory, "native.jsonl");
    child.status = "completed";
    store.update(child);
    store.close();
    const manifest = JSON.parse(readFileSync(store.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      executionId: store.executionId,
      rootTranscriptPath: "/native/root.jsonl",
      agents: [{ id: "child", status: "completed", transcriptPath: child.transcriptPath }],
    });
    expect(statSync(store.manifestPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(store.manifestPath)).mode & 0o777).toBe(0o700);
  });

  test("new executions never rewrite an unfinished historical tree", () => {
    const directory = fixture();
    const first = createManifestStore(directory, "root");
    first.create(record(first));
    const previous = readFileSync(first.manifestPath, "utf8");
    const next = createManifestStore(directory, "root");
    expect(next.executionId).not.toBe(first.executionId);
    expect(next.manifestPath).not.toBe(first.manifestPath);
    expect(JSON.parse(readFileSync(next.manifestPath, "utf8")).agents).toEqual([]);
    expect(readFileSync(first.manifestPath, "utf8")).toBe(previous);
    first.close();
    expect(() => first.update(record(first))).toThrow(/closed/);
    next.close();
  });

  test("rejects foreign identities and paths without replacing the previous manifest", () => {
    const store = createManifestStore(fixture(), "root");
    const child = record(store);
    store.create(child);
    const previous = readFileSync(store.manifestPath, "utf8");
    expect(() => store.update({ ...child, executionId: "other" })).toThrow(/another execution/);
    expect(() => store.update({ ...child, transcriptPath: "/outside/native.jsonl" })).toThrow(
      /allocated directory/,
    );
    expect(readFileSync(store.manifestPath, "utf8")).toBe(previous);
    expect(() => store.create(child)).toThrow(/already exists/);
  });

  test("rejects oversized writes without replacing the previous manifest", () => {
    const store = createManifestStore(fixture(), "root");
    const child = record(store);
    store.create(child);
    const previous = readFileSync(store.manifestPath, "utf8");
    expect(() => store.create({ ...child, id: "x".repeat(17 * 1024 * 1024) })).toThrow(
      /storage limit/,
    );
    expect(readFileSync(store.manifestPath, "utf8")).toBe(previous);
  });
});
