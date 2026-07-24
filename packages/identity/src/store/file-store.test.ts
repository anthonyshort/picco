import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { describeStoreContract, storedEnvelope } from "../testing/store-contract.js";
import { fileStore } from "./file-store.js";

describe("fileStore", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "connections-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  describeStoreContract("contract", () => fileStore(path.join(directory, String(Math.random()))));

  test("envelopes land as 0600 files under the store directory", async () => {
    const store = fileStore(directory);
    await store.set("telegram:1", "github", storedEnvelope(1));

    const file = path.join(directory, "users", encodeURIComponent("telegram:1"), "github.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("surfaces a filesystem failure during remove instead of reporting absence", async () => {
    const store = fileStore(directory);

    // A directory where the envelope file should be — rm fails on it, and that must not read as
    // "was not connected" while data stays on disk.
    mkdirSync(path.join(directory, "users", encodeURIComponent("telegram:1"), "github.json"), {
      recursive: true,
    });
    await expect(store.remove("telegram:1", "github")).rejects.toThrow();
  });

  test.each([
    ["truncated JSON", '{"v":1,"blob":"opaque'],
    ["valid JSON that fails the envelope schema", '{"v":999}'],
  ])("treats %s as absent", async (_flavor, contents) => {
    const store = fileStore(directory);
    await store.set("telegram:1", "github", storedEnvelope(1));
    const file = path.join(directory, "users", encodeURIComponent("telegram:1"), "github.json");
    writeFileSync(file, contents);

    expect(await store.get("telegram:1", "github")).toBeNull();
    expect(await store.list("telegram:1")).toEqual([]);
  });
});
