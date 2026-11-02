import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakePluginContext } from "@picco-agent/core/testing";
import type { ToolContext } from "@picco-agent/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { browserChecks } from "./index.js";
import type { BrowserChecks, BrowserChecksOptions, BrowserJob } from "./types.js";

const revision = "a".repeat(40);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBRsAAAAASUVORK5CYII=",
  "base64",
);
const directories: string[] = [];
const plugins: BrowserChecks[] = [];

afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.stop?.();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("browser checks plugin", () => {
  test("acknowledges a source request immediately and completes after image inspection", async () => {
    const harness = await createHarness();
    const accepted = harness.plugin.checks.start(request());
    expect(accepted.state).toBe("queued");
    expect(accepted.result).toBeNull();
    await expectState(harness.plugin, accepted.id, "complete");
    const job = harness.plugin.checks.status(accepted.id);
    expect(job.result?.answer).toBe("supported");
    expect(harness.ctx.turns).toHaveLength(2);
    expect(harness.inspected()).toBe(true);
    expect(readFileSync(job.artifacts[0]!.file)).toEqual(png);
    expect(
      harness.requests.filter((entry) => entry.method === "POST" && entry.url.endsWith("/runs")),
    ).toHaveLength(1);
  });

  test("reuses an accepted request without launching another check", async () => {
    const harness = await createHarness();
    const accepted = harness.plugin.checks.start(request());
    expect(harness.plugin.checks.start(request()).id).toBe(accepted.id);
    await expectState(harness.plugin, accepted.id, "complete");
    expect(harness.plugin.checks.start(request()).state).toBe("complete");
    expect(harness.launchKeys).toEqual([accepted.dispatchKey]);
    expect(harness.ctx.turns).toHaveLength(2);
  });

  test("blocks a different deployed revision before media retrieval or assessment", async () => {
    const harness = await createHarness({ observedRevision: "b".repeat(40) });
    const job = harness.plugin.checks.start(request());
    await expectState(harness.plugin, job.id, "blocked");
    expect(harness.ctx.turns).toHaveLength(1);
    expect(harness.plugin.checks.status(job.id).result?.summary).toContain("deployed revision");
    expect(harness.requests.some((entry) => entry.url.includes("web-reply-images"))).toBe(false);
  });

  test("blocks unauthorised media without pretending Atlas links were inspected", async () => {
    const harness = await createHarness({ mediaStatus: 401 });
    const job = harness.plugin.checks.start(request());
    await expectState(harness.plugin, job.id, "blocked");
    expect(harness.ctx.turns).toHaveLength(1);
    expect(harness.inspected()).toBe(false);
    expect(harness.plugin.checks.status(job.id).result?.limits.join(" ")).toContain(
      "authorised Atlas access",
    );
  });

  test("cancels a known remote run on timeout and reports when it still runs", async () => {
    const harness = await createHarness({ running: true, timeoutMs: 100 });
    const job = harness.plugin.checks.start(request());
    await vi.waitFor(() => expect(harness.plugin.checks.status(job.id).remoteStopped).toBe(false), {
      interval: 5,
    });
    expect(harness.plugin.checks.status(job.id).state).toBe("timed-out");
    expect(harness.requests.filter((entry) => entry.url.endsWith("/cancel"))).toHaveLength(1);
    expect(harness.ctx.turns).toHaveLength(1);
  });

  test("cancels queued work before starting a supervisor or Atlas run", async () => {
    const harness = await createHarness();
    const job = harness.plugin.checks.start(request());
    await expect(harness.plugin.checks.cancel(job.id)).resolves.toMatchObject({
      state: "cancelled",
      remoteStopped: true,
    });
    expect(harness.ctx.turns).toHaveLength(0);
    expect(harness.launchKeys).toEqual([]);
  });

  test("enforces the caller identity for status and cancellation", async () => {
    const harness = await createHarness({ running: true });
    const original = await call(harness.plugin, "browser_check_start", request(), "one");
    const job = JSON.parse(String(original));
    await expect(
      call(harness.plugin, "browser_check_status", { id: job.id }, "two"),
    ).rejects.toThrow("another caller");
    await expect(
      call(harness.plugin, "browser_check_cancel", { id: job.id }, "two"),
    ).rejects.toThrow("another caller");
    expect(
      JSON.parse(String(await call(harness.plugin, "browser_check_status", { id: job.id }, "one")))
        .id,
    ).toBe(job.id);
    const tool = harness.plugin.tools?.find((entry) => entry.name === "browser_check_status");
    expect(() =>
      tool?.execute(tool.input.parse({ id: job.id }), {
        logger: harness.ctx.logger,
        caller: { kind: "session", ref: { source: "untrusted", key: "one" } },
      }),
    ).toThrow("may not manage");
  });

  test("callback failures do not repeat browser work", async () => {
    let completedDeliveries = 0;
    const harness = await createHarness({
      onUpdate: async (job) => {
        if (job.state === "complete") {
          completedDeliveries++;
          throw new Error("Receiver unavailable");
        }
      },
    });
    const job = harness.plugin.checks.start(request());
    await expectState(harness.plugin, job.id, "complete");
    await vi.waitFor(() => expect(completedDeliveries).toBeGreaterThanOrEqual(2), {
      timeout: 2500,
      interval: 10,
    });
    expect(harness.launchKeys).toHaveLength(1);
    expect(harness.ctx.turns).toHaveLength(2);
    expect(harness.plugin.checks.status(job.id).state).toBe("complete");
  });

  test("adopts a saved known run after restart without another launch or preparation", async () => {
    const harness = await createHarness({ running: true });
    const job = harness.plugin.checks.start(request());
    await expectState(harness.plugin, job.id, "running");
    await harness.plugin.stop?.();
    harness.controls.running = false;
    await harness.plugin.start?.(harness.ctx);
    await expectState(harness.plugin, job.id, "complete");
    expect(harness.launchKeys).toEqual([job.dispatchKey]);
    expect(harness.ctx.turns).toHaveLength(2);
  });

  test("reconciles an uncertain launch after restart using the original key", async () => {
    const harness = await createHarness({ uncertain: true });
    const job = harness.plugin.checks.start(request());
    await expectState(harness.plugin, job.id, "uncertain");
    await harness.plugin.stop?.();
    harness.controls.uncertain = false;
    await harness.plugin.start?.(harness.ctx);
    await expectState(harness.plugin, job.id, "complete");
    expect(harness.launchKeys).toEqual([job.dispatchKey, job.dispatchKey]);
    expect(harness.ctx.turns).toHaveLength(2);
  });

  test("does not relaunch an uncertain intent under changed Atlas credentials", async () => {
    const harness = await createHarness({ uncertain: true });
    const job = harness.plugin.checks.start(request());
    await expectState(harness.plugin, job.id, "uncertain");
    await harness.plugin.stop?.();
    harness.atlas.token = "another-principal";
    harness.controls.uncertain = false;
    await harness.plugin.start?.(harness.ctx);
    await expectState(harness.plugin, job.id, "uncertain");
    expect(harness.plugin.checks.status(job.id).error).toContain("configuration changed");
    expect(harness.launchKeys).toEqual([job.dispatchKey]);
  });

  test("can request cancellation of a saved remote run after local work ended", async () => {
    const harness = await createHarness({ running: true, timeoutMs: 100 });
    const job = harness.plugin.checks.start(request());
    await vi.waitFor(() => expect(harness.plugin.checks.status(job.id).remoteStopped).toBe(false), {
      interval: 5,
    });
    await harness.plugin.stop?.();
    await harness.plugin.start?.(harness.ctx);
    await expect(harness.plugin.checks.cancel(job.id)).resolves.toMatchObject({
      state: "cancelled",
      remoteStopped: false,
    });
    expect(harness.requests.filter((entry) => entry.url.endsWith("/cancel"))).toHaveLength(2);
    expect(harness.launchKeys).toHaveLength(1);
  });
});

/**
 * Exercise real plugin sessions, storage, HTTP parsing and evidence collection without live
 * services.
 */
async function createHarness(
  opts: {
    observedRevision?: string;
    mediaStatus?: number;
    running?: boolean;
    uncertain?: boolean;
    timeoutMs?: number;
    onUpdate?: BrowserChecksOptions["onUpdate"];
  } = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "browser-plugin-"));
  directories.push(directory);
  const requests: { url: string; method: string }[] = [];
  const launchKeys: string[] = [];
  const controls = { running: opts.running ?? false, uncertain: opts.uncertain ?? false };
  let inspected = false;
  const ctx = createFakePluginContext({
    source: "browser-checks",
    reply: async ({ key, prompt }) => {
      const invoke = (name: string, input: unknown) => {
        const owned = ctx.sessionTools
          .findLast((entry) => entry.key === key)
          ?.tools.find((entry) => entry.name === name);
        if (!owned) throw new Error(`Missing supervisor tool ${name}`);
        return owned.execute(owned.input.parse(input), {
          logger: ctx.logger,
          caller: { kind: "session", ref: { source: "browser-checks", key: key ?? "missing" } },
        });
      };
      if (prompt.startsWith("Prepare"))
        await invoke("browser_check_plan", {
          url: "https://preview.example/settings",
          steps: ["Select Paid and check every row"],
          expected: "Only paid rows remain",
          setup: "Use seeded invoices",
        });
      else {
        const evidence = await invoke("browser_check_evidence", {});
        expect(evidence).toMatchObject({
          content: expect.arrayContaining([
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ]),
        });
        inspected = true;
        await invoke("browser_check_answer", {
          answer: "supported",
          summary: "Paid filter displays only paid invoices",
          observations: ["Paid rows displayed"],
          limits: [],
        });
      }
      return "Recorded";
    },
  });
  ctx.filePath = (...segments) => path.join(directory, ...segments);
  const fetchResponse: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/runs")) {
      launchKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "missing");
      if (controls.uncertain) throw new Error("Response lost after admission");
      return new Response(
        'event: custom\ndata: {"name":"atlas.workflow.started","data":{"run_id":"run-1","thread_id":"thread-1"}}\n\n',
      );
    }
    if (url.endsWith("/cancel")) return Response.json({ status: "running" });
    if (url.endsWith("/runs/run-1"))
      return Response.json({
        status: controls.running ? "running" : "completed",
        nodes: [
          {
            node_id: "tester",
            status: "succeeded",
            iteration: 0,
            output_json: {
              url: "https://preview.example/settings",
              revision: opts.observedRevision ?? revision,
              revisionEvidence: "Deployment metadata SHA",
              observations: ["Paid rows displayed"],
              limits: [],
              artifacts: [
                {
                  kind: "screenshot",
                  url: "https://atlas.example/api/v1/threads/thread-1/web-reply-images/image-1",
                },
              ],
            },
          },
        ],
      });
    if (url.includes("web-reply-images"))
      return new Response(png, {
        status: opts.mediaStatus ?? 200,
        headers: { "Content-Type": "image/png" },
      });
    throw new Error("Unexpected test request");
  };
  const atlas = {
    url: "https://atlas.example",
    token: "host-only",
    workflow: "tester",
    fetch: fetchResponse,
  };
  const plugin = browserChecks({
    atlas,
    profiles: {
      preview: {
        origins: ["https://preview.example"],
        instructions: "Use seeded disposable invoices",
      },
    },
    allowedSources: ["reviews"],
    timeoutMs: opts.timeoutMs ?? 5000,
    pollIntervalMs: 10,
    onUpdate: opts.onUpdate,
  });
  plugins.push(plugin);
  await plugin.start?.(ctx);
  return { plugin, ctx, requests, launchKeys, controls, atlas, inspected: () => inspected };
}

/**
 * A source-only request exercises preparation rather than supplying its target URL.
 */
function request() {
  return {
    requestKey: "invoice-filter",
    profile: "preview",
    question: "Does Paid filter invoices?",
    expected: "Only paid rows remain",
    source: "https://github.com/example/app/pull/1",
    revision,
  };
}

/**
 * Wait on saved observable state rather than assuming a worker duration.
 */
async function expectState(plugin: BrowserChecks, id: string, state: BrowserJob["state"]) {
  await vi.waitFor(() => expect(plugin.checks.status(id).state).toBe(state), { interval: 5 });
}

/**
 * Invoke public tools with an authenticated source identity.
 */
async function call(plugin: BrowserChecks, name: string, input: unknown, key: string) {
  const entry = plugin.tools?.find((candidate) => candidate.name === name);
  if (!entry) throw new Error("Missing plugin tool");
  const context: ToolContext = {
    logger: createFakePluginContext().logger,
    caller: { kind: "session", ref: { source: "reviews", key } },
  };
  return entry.execute(entry.input.parse(input), context);
}
