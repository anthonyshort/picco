import { createHash } from "node:crypto";
import { z } from "zod";
import type { PluginContext } from "@picco-agent/core";
import { AtlasClientError, createAtlasClient } from "./atlas.js";
import { collectEvidence } from "./evidence.js";
import { createSupervisor, ensureTarget } from "./supervisor.js";
import { stopAtlasRun } from "./cancellation.js";
import { BrowserEvidenceSchema, type BrowserChecksOptions } from "./types.js";
import type { createBrowserStore } from "./store.js";

const NodeOutputsSchema = z.object({
  nodes: z
    .array(
      z.object({
        node_id: z.string(),
        output_json: z.unknown(),
        iteration: z.number().optional(),
      }),
    )
    .max(1000),
});

/**
 * Run one saved job without tying its lifetime to the submitting session.
 */
export function createCheckRunner(
  ctx: PluginContext,
  opts: BrowserChecksOptions,
  store: ReturnType<typeof createBrowserStore>,
) {
  const atlas = createAtlasClient(opts.atlas);
  const supervisor = createSupervisor(ctx, opts);

  return async function run(
    id: string,
    signal: AbortSignal,
    shuttingDown: () => boolean,
  ): Promise<void> {
    const initial = store.get(id);
    const profile = opts.profiles[initial.request.profile];
    let job = initial;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    const save = (change: Parameters<typeof store.update>[1]) => {
      job = store.update(id, change);
      return job;
    };
    const inconclusive = (reason: string) => ({
      answer: "inconclusive" as const,
      summary: reason,
      observations: job.evidence?.observations ?? [],
      limits: [reason, ...(job.evidence?.limits ?? [])].slice(0, 20),
    });
    try {
      timer = setTimeout(() => timeout.abort("deadline"), Math.max(0, job.deadline - Date.now()));
      if (Date.now() >= job.deadline) timeout.abort("deadline");
      combined.throwIfAborted();
      if (!profile) {
        save({
          state: "blocked",
          error: "Environment profile is no longer configured",
          result: inconclusive("Environment unavailable"),
        });
        return;
      }
      const configuration = createHash("sha256")
        .update(
          JSON.stringify({
            url: opts.atlas.url,
            workflow: opts.atlas.workflow,
            credential: createHash("sha256").update(opts.atlas.token).digest("hex"),
            resultNode: opts.atlas.resultNode ?? "tester",
            origins: profile.origins,
            instructions: profile.instructions,
          }),
        )
        .digest("hex");
      if (job.configuration !== null && job.configuration !== configuration) {
        save({
          state: "uncertain",
          error:
            "Environment or Atlas configuration changed; reconcile the saved run before continuing",
        });
        return;
      }
      if (job.configuration === null) save({ configuration });
      if (!job.plan) {
        if (initial.state !== "queued") {
          save({
            state: "blocked",
            result: inconclusive("Preparation was interrupted; a new explicit request is required"),
          });
          return;
        }
        save({ state: "preparing" });
        const plan = await supervisor.prepare(job, profile, combined);
        save({ plan });
      }
      if (!job.plan) throw new Error("Prepared browser instructions are missing");
      ensureTarget(job.plan.url, profile);
      if (!job.remote) {
        if (Date.now() - job.createdAt >= 24 * 60 * 60_000) {
          save({
            state: "uncertain",
            error: "Atlas dispatch key expired; operator reconciliation is required",
          });
          return;
        }
        save({ state: "launching" });
        const remote = await atlas.launch({
          key: job.dispatchKey,
          payload: {
            request: job.request,
            plan: job.plan,
            environment: profile.instructions,
            deadline: job.deadline,
            resultContract:
              "Return JSON from the configured tester node: {url, revision: commit SHA or null, revisionEvidence, observations: string[], limits: string[], artifacts: [{kind: screenshot or video, url: prepared downloadable Atlas resource}]}. Verify the deployed revision before browser actions when requested. Use screenshots by default, a short video only when requested. No publication or UX judgements. Use only disposable fixtures and one named browser session. Stop at the absolute deadline. Return partial evidence on blockers. Close only your own session.",
          },
          signal: combined,
        });
        save({ remote, state: "running" });
      }
      if (!job.remote) throw new Error("Atlas did not identify its run");
      let output: unknown;
      while (true) {
        combined.throwIfAborted();
        let status;
        try {
          status = await atlas.status(job.remote.runId, combined);
        } catch (err) {
          if (
            err instanceof AtlasClientError &&
            (err.statusCode === 429 || (err.statusCode !== undefined && err.statusCode >= 500))
          ) {
            await wait(opts.pollIntervalMs ?? 2000, combined);
            continue;
          }
          throw err;
        }
        switch (status.state) {
          case "running":
            await wait(opts.pollIntervalMs ?? 2000, combined);
            continue;
          case "complete":
            save({ remoteStopped: true });
            output = status.output;
            break;
          case "failed":
            save({
              state: "failed",
              remoteStopped: true,
              error: "Atlas execution failed",
              result: inconclusive("Atlas did not complete the scenario"),
            });
            return;
          case "cancelled":
            save({
              state: "cancelled",
              remoteStopped: true,
              result: inconclusive("Atlas execution was cancelled"),
            });
            return;
          default:
            throw new Error("Unsupported Atlas execution state");
        }
        break;
      }
      const nodes = NodeOutputsSchema.parse(output).nodes.filter(
        (node) => node.node_id === (opts.atlas.resultNode ?? "tester"),
      );
      if (nodes.length !== 1)
        throw new Error("Atlas must return exactly one configured tester-node result");
      const value = nodes[0].output_json;
      const evidence = BrowserEvidenceSchema.parse(
        typeof value === "string" ? JSON.parse(value) : value,
      );
      save({ evidence });
      ensureTarget(evidence.url, profile);
      if (
        job.request.revision &&
        (evidence.revision !== job.request.revision || !evidence.revisionEvidence.trim())
      ) {
        save({
          state: "blocked",
          result: inconclusive(
            "The preview's deployed revision was not verified against the requested commit",
          ),
        });
        return;
      }
      const collected = await collectEvidence(
        evidence,
        opts.atlas,
        ctx.filePath("evidence", id),
        combined,
        (artifacts) => {
          save({ artifacts });
        },
      );
      save({
        artifacts: collected.artifacts,
        evidence: { ...evidence, limits: [...evidence.limits, ...collected.limits].slice(0, 20) },
      });
      if (!job.artifacts.length) {
        save({
          state: "blocked",
          result: inconclusive(
            "No screenshot or playable recording could be retrieved through authorised Atlas access",
          ),
        });
        return;
      }
      save({ state: "assessing" });
      const result = await supervisor.assess(job, profile, combined);
      save({
        result: {
          ...result,
          limits: [...new Set([...result.limits, ...(job.evidence?.limits ?? [])])].slice(0, 20),
        },
      });
    } catch (err) {
      if (shuttingDown()) return;
      if (combined.aborted) {
        const state = timeout.signal.aborted ? "timed-out" : "cancelled";
        save({
          state,
          result: inconclusive(
            state === "timed-out"
              ? "The browser-check deadline expired"
              : "Browser check cancelled",
          ),
        });
        if (job.remote && job.remoteStopped !== true) {
          save({ remoteStopped: await stopAtlasRun(atlas, job.remote.runId) });
        }
      } else if (err instanceof AtlasClientError && err.ambiguous && !job.remote) {
        save({
          state: "uncertain",
          error:
            "Atlas launch was not confirmed; retain this job and dispatch key for reconciliation",
        });
      } else {
        const phase = job.state;
        const diagnostic =
          err instanceof AtlasClientError
            ? `Atlas request failed${err.statusCode === undefined ? "" : ` (HTTP ${err.statusCode})`}${err.code ? `: ${err.code}` : ""}`
            : err instanceof z.ZodError
              ? `Invalid evidence: ${err.issues
                  .slice(0, 5)
                  .map((issue) => `${issue.code} at ${issue.path.join(".")}`)
                  .join(", ")}`
              : "Supervisor or evidence processing failed";
        save({
          state: "failed",
          error: `${phase}: ${diagnostic}`.slice(0, 4000),
          result: inconclusive("The check could not produce a validated answer"),
        });
        ctx.logger.error("Browser check failed", {
          id,
          phase,
          diagnostic,
          kind: err instanceof Error ? err.name : "Unknown",
        });
        if (job.remote && job.remoteStopped !== true)
          save({ remoteStopped: await stopAtlasRun(atlas, job.remote.runId) });
      }
    } finally {
      if (timer) clearTimeout(timer);
      await closeSupervisor(supervisor, id, shuttingDown, store);
    }
    if (job.state === "assessing" && job.result !== null) save({ state: "complete" });
  };
}

/**
 * Failed teardown stops further admissions rather than reusing an unconfirmed worker.
 */
async function closeSupervisor(
  supervisor: ReturnType<typeof createSupervisor>,
  id: string,
  shuttingDown: () => boolean,
  store: ReturnType<typeof createBrowserStore>,
): Promise<void> {
  try {
    await supervisor.close(id);
  } catch {
    if (!shuttingDown())
      store.update(id, { state: "failed", error: "Supervisor shutdown could not be confirmed" });
    throw new Error("Browser supervisor shutdown could not be confirmed");
  }
}

/**
 * Delay status reads without extending the accepted job deadline.
 */
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
