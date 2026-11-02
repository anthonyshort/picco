import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectEvidence } from "./evidence.js";
import { BrowserArtifactSchema, BrowserEvidenceSchema, type BrowserArtifact } from "./types.js";

const directories: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6sAAAAASUVORK5CYII=",
  "base64",
);
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64",
);
const connection = { url: "https://atlas.example.test", token: "host-secret" };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("browser evidence", () => {
  test.each([
    { label: "PNG", data: png, mimeType: "image/png" },
    { label: "JPEG", data: jpeg, mimeType: "image/jpeg" },
  ])(
    "downloads a $label screenshot using scoped host authentication without redirects",
    async ({ data, mimeType }) => {
      const requests: { url: string; options?: RequestInit }[] = [];
      const fetch: typeof globalThis.fetch = async (input, options) => {
        requests.push({ url: String(input), options });
        return new Response(data, { headers: { "content-type": "application/octet-stream" } });
      };
      const result = await collectEvidence(
        createEvidence(),
        { ...connection, fetch },
        createDirectory(),
        AbortSignal.timeout(1000),
      );
      expect(result.limits).toEqual([]);
      expect(result.artifacts).toHaveLength(1);
      const artifact = result.artifacts[0]!;
      expect(BrowserArtifactSchema.parse(artifact)).toEqual(artifact);
      expect(artifact).toMatchObject({
        kind: "screenshot",
        mimeType,
        bytes: data.byteLength,
      });
      expect(readFileSync(artifact.file)).toEqual(data);
      expect(statSync(artifact.file).mode & 0o777).toBe(0o600);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.options?.redirect).toBe("error");
      expect(new Headers(requests[0]?.options?.headers).get("authorization")).toBe(
        "Bearer host-secret",
      );
      expect(new Headers(requests[0]?.options?.headers).has("cookie")).toBe(false);
    },
  );

  test("rejects outside origins and credential-bearing URLs before making a request", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(png);
    };
    const evidence = createEvidence();
    evidence.artifacts = [
      { kind: "screenshot", url: "https://other.example.test/shot.png" },
      { kind: "screenshot", url: "https://user:password@atlas.example.test/shot.png" },
    ];
    const result = await collectEvidence(
      evidence,
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(calls).toBe(0);
    expect(result.artifacts).toEqual([]);
    expect(result.limits).toHaveLength(2);
  });

  test("rejects an HTML login page even if its content type claims to be an image", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response("<html>Sign in</html>", { headers: { "content-type": "image/png" } });
    const result = await collectEvidence(
      createEvidence(),
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(result.artifacts).toEqual([]);
    expect(result.limits).toHaveLength(1);
  });

  test("preserves a screenshot when a second download is not authorised", async () => {
    const evidence = createEvidence();
    evidence.artifacts.push({ kind: "video", url: "https://atlas.example.test/movie.mp4" });
    const fetch: typeof globalThis.fetch = async (input) =>
      String(input).endsWith("movie.mp4")
        ? new Response("No access", { status: 401 })
        : new Response(png);
    const result = await collectEvidence(
      evidence,
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["screenshot"]);
    expect(result.limits).toEqual([expect.stringContaining("video 2")]);
  });

  test("does not return redirected media or leak signed URLs from transport errors", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("Redirected to https://private.example.test/?secret=host-secret");
    };
    const result = await collectEvidence(
      createEvidence(),
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(result.artifacts).toEqual([]);
    expect(result.limits).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("host-secret");
    expect(JSON.stringify(result)).not.toContain("private.example.test");
  });

  test("rejects oversized responses before consuming their body", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(png, { headers: { "content-length": String(25 * 1024 * 1024 + 1) } });
    const result = await collectEvidence(
      createEvidence(),
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(result.artifacts).toEqual([]);
    expect(result.limits).toHaveLength(1);
  });

  test("also caps streamed responses without a content length", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(25 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      );
    const result = await collectEvidence(
      createEvidence(),
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(result.artifacts).toEqual([]);
    expect(result.limits).toHaveLength(1);
  });

  test("rejects invalid recordings instead of treating file extensions as proof", async () => {
    const evidence = createEvidence();
    evidence.artifacts = [{ kind: "video", url: "https://atlas.example.test/movie.mp4" }];
    const fetch: typeof globalThis.fetch = async () =>
      new Response("Not an MP4 file", { headers: { "content-type": "video/mp4" } });
    const result = await collectEvidence(
      evidence,
      { ...connection, fetch },
      createDirectory(),
      AbortSignal.timeout(1000),
    );
    expect(result.artifacts).toEqual([]);
    expect(result.limits).toHaveLength(1);
  });

  test("propagates cancellation rather than returning a successful empty collection", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Check cancelled"));
    const fetch: typeof globalThis.fetch = async () => new Response(png);
    await expect(
      collectEvidence(
        createEvidence(),
        { ...connection, fetch },
        createDirectory(),
        controller.signal,
      ),
    ).rejects.toThrow("Check cancelled");
  });

  test("saves a verified screenshot before cancellation interrupts the next download", async () => {
    const evidence = createEvidence();
    evidence.artifacts.push({ kind: "screenshot", url: "https://atlas.example.test/second.png" });
    const controller = new AbortController();
    const cancellation = new Error("Cancelled during the second download");
    let saved: BrowserArtifact[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).endsWith("second.png")) {
        expect(saved).toHaveLength(1);
        controller.abort(cancellation);
        throw cancellation;
      }
      return new Response(png);
    };
    await expect(
      collectEvidence(
        evidence,
        { ...connection, fetch },
        createDirectory(),
        controller.signal,
        (artifacts) => {
          saved = artifacts.map((artifact) => BrowserArtifactSchema.parse(artifact));
        },
      ),
    ).rejects.toBe(cancellation);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: "screenshot",
      source: "https://atlas.example.test/shot.png",
      mimeType: "image/png",
    });
    expect(readFileSync(saved[0]!.file)).toEqual(png);
  });

  test("propagates a persistence callback failure instead of reporting a media failure", async () => {
    const evidence = createEvidence();
    evidence.artifacts.push({ kind: "screenshot", url: "https://atlas.example.test/second.png" });
    let downloads = 0;
    const fetch: typeof globalThis.fetch = async () => {
      downloads++;
      return new Response(png);
    };
    const failure = new Error("Evidence persistence failed");
    await expect(
      collectEvidence(
        evidence,
        { ...connection, fetch },
        createDirectory(),
        AbortSignal.timeout(1000),
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(downloads).toBe(1);
  });
});

/**
 * Represent a prepared media reference returned by the configured Atlas workflow.
 */
function createEvidence() {
  return BrowserEvidenceSchema.parse({
    url: "https://preview.example.test/settings",
    revision: null,
    revisionEvidence: "",
    observations: ["Only paid rows remained"],
    limits: [],
    artifacts: [{ kind: "screenshot", url: "https://atlas.example.test/shot.png" }],
  });
}

/**
 * Keep downloaded test artifacts outside the source tree.
 */
function createDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "browser-evidence-"));
  directories.push(directory);
  return directory;
}
