import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { readReviewLogs } from "./diagnostics.js";

/**
 * Diagnostics stay bounded and do not expose files reached through worker-created symlinks.
 */
test("reads bounded artifact logs and skips symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-diagnostics-"));
  try {
    const directory = path.join(root, "run");
    await mkdir(directory);
    await writeFile(path.join(directory, "events.log"), "first\nsecond\nthird\n");
    await writeFile(path.join(root, "private.log"), "secret outside the run");
    await symlink(path.join(root, "private.log"), path.join(directory, "escaped.log"));
    expect(await readReviewLogs(directory, 1, 1)).toMatchObject({
      files: ["events.log"],
      lines: ["events.log: second"],
      nextOffset: 2,
    });
    await symlink(directory, path.join(root, "alias"));
    await expect(readReviewLogs(path.join(root, "alias"), 0, 30)).rejects.toThrow("symlinks");
    expect(await readReviewLogs(path.join(root, "missing"), 0, 30)).toMatchObject({
      available: false,
      lines: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
