import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Read a bounded window of artifact logs without following symlinks or taking caller paths.
 */
export async function readReviewLogs(directory: string, offset: number, limit: number) {
  const files: string[] = [];
  let visited = 0;
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 6 || visited >= 500) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++visited > 500) return;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && /\.(?:jsonl|output|log)$/.test(entry.name)) files.push(file);
    }
  }
  const lines: string[] = [];
  try {
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== path.resolve(directory)
    )
      throw new Error("Review artifact directory must not contain symlinks");
    await walk(directory, 0);
    for (const file of files.sort().slice(-20)) {
      if (!(await realpath(file)).startsWith(`${directory}${path.sep}`)) continue;
      const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await descriptor.stat();
        if (!stat.isFile()) continue;
        const start = Math.max(0, stat.size - 64 * 1024);
        const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
        const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, start);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const tail = start ? text.slice(text.indexOf("\n") + 1) : text;
        lines.push(
          ...tail
            .split("\n")
            .filter(Boolean)
            .map((line) => `${path.relative(directory, file)}: ${line.slice(0, 2000)}`),
        );
      } finally {
        await descriptor.close();
      }
    }
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  }
  const recent = lines.slice(-1000);
  return {
    available: files.length > 0,
    files: files.map((file) => path.relative(directory, file)),
    lines: recent.slice(offset, offset + limit),
    nextOffset: offset + limit < recent.length ? offset + limit : null,
    note: "Bounded artifact logs only; runtime-private logs are unavailable. Missing activity does not establish worker termination.",
  };
}
