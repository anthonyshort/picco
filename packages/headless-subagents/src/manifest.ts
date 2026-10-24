import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentRecordSchema, type AgentRecord } from "./types.js";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const ManifestSchema = z.object({
  format: z.literal("headless-subagents"),
  version: z.literal(1),
  rootSessionId: z.string().min(1).max(512),
  executionId: z.string().uuid(),
  rootTranscriptPath: z.string().optional(),
  createdAt: z.iso.datetime(),
  agents: z.array(AgentRecordSchema).max(MAX_RECORDS),
});

/**
 * One writer owns a fresh execution manifest; previous executions are never reopened or changed.
 */
export interface ManifestStore {
  executionId: string;
  manifestPath: string;
  pathsFor(agentId: string): { transcriptDirectory: string };
  create(record: AgentRecord): void;
  update(record: AgentRecord): void;
  close(): void;
}

/**
 * Persist ancestry and lifecycle state atomically, leaving conversation content to native Pi files.
 */
export function createManifestStore(
  outputDirectory: string,
  rootSessionId: string,
  rootTranscriptPath?: string,
): ManifestStore {
  const executionId = randomUUID();
  ensurePrivateDirectory(outputDirectory);
  const rootDirectory = path.join(realpathSync(outputDirectory), identityHash(rootSessionId));
  ensurePrivateDirectory(rootDirectory);
  const directory = path.join(rootDirectory, executionId);
  ensurePrivateDirectory(directory);
  const manifestPath = path.join(directory, "manifest.json");
  let manifest = ManifestSchema.parse({
    format: "headless-subagents",
    version: 1,
    rootSessionId,
    executionId,
    rootTranscriptPath,
    createdAt: new Date().toISOString(),
    agents: [],
  });
  let closed = false;
  writeManifest(manifestPath, manifest);

  function pathsFor(agentId: string) {
    if (closed) throw new Error("Execution manifest is closed");
    const agentsDirectory = path.join(directory, "agents");
    ensurePrivateDirectory(agentsDirectory);
    const transcriptDirectory = path.join(agentsDirectory, identityHash(agentId));
    ensurePrivateDirectory(transcriptDirectory);
    return { transcriptDirectory };
  }

  function persist(record: AgentRecord, creating: boolean) {
    if (closed) throw new Error("Execution manifest is closed");
    const value = AgentRecordSchema.parse(record);
    if (value.rootSessionId !== rootSessionId || value.executionId !== executionId)
      throw new Error("Agent belongs to another execution");
    const allocated = pathsFor(value.id).transcriptDirectory;
    if (value.transcriptPath !== null) {
      const relative = path.relative(allocated, path.resolve(value.transcriptPath));
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Transcript must remain in its allocated directory");
    }
    const index = manifest.agents.findIndex((agent) => agent.id === value.id);
    if (creating !== (index === -1))
      throw new Error(creating ? "Agent identity already exists" : "Agent identity does not exist");
    const agents = [...manifest.agents];
    if (index === -1) agents.push(value);
    else agents[index] = value;
    const next = ManifestSchema.parse({ ...manifest, agents });
    writeManifest(manifestPath, next);
    manifest = next;
  }

  return {
    executionId,
    manifestPath,
    pathsFor,
    create: (record) => persist(record, true),
    update: (record) => persist(record, false),
    close() {
      closed = true;
    },
  };
}

/**
 * IDs are data rather than filesystem path components.
 */
function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Managed directories are private and cannot redirect storage through a symlink.
 */
function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Manifest directory must not be a symlink");
  chmodSync(directory, 0o700);
}

/**
 * A failed replacement leaves the prior complete manifest intact.
 */
function writeManifest(file: string, value: z.infer<typeof ManifestSchema>): void {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    throw new Error("Execution manifest exceeds its storage limit");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}
