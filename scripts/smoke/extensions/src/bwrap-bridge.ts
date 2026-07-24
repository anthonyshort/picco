/**
 * Bwrap runtime + the CORE-DEFAULT bridge extension (a host tool).
 *
 * Node_modules resolution: none for you. The bridge extension is core-owned and bundled — core
 * resolves it and the runtime makes it available in the sandbox the same way as any bundled
 * package, with its deps inlined. You just pass host `tool()`s; the bridge exposes them inside the
 * session and proxies each call back to the host over HTTP. See docs/concepts/security.md.
 *
 * The tool's execute() runs on the HOST (not in the sandbox), so it can hold secrets and shared
 * state. Here it just returns a sentinel so the smoke check can assert the round-trip.
 */
import * as z from "zod";
import { createAgent, tool } from "@picco-agent/core";
import { bwrap } from "@picco-agent/runtime-bwrap";
import { model, models, runCheck } from "./shared.js";

const SENTINEL = "bridge-host-tool-pong";

const ping = tool({
  name: "host_ping",
  description: "Returns a fixed sentinel string, executed on the host over the bridge.",
  input: z.object({}),
  execute: () => SENTINEL,
});

const agent = createAgent({
  name: "ext-bwrap-bridge",
  pi: { model, models },
  runtime: bwrap(),
  tools: [ping],
});

await runCheck({ label: "bwrap-bridge", agent, toolName: "host_ping", sentinel: SENTINEL });
