/**
 * @picco-agent/runtime-bwrap — the bubblewrap Runtime: each pi session runs in a per-session Linux
 * namespace jail built from the resolved session config (see docs/guides/runtimes/bwrap.md). For no
 * isolation, use `local()` from @picco-agent/runtime-local.
 *
 * `buildBwrapArgs` is exported for advanced callers that build a jail directly (e.g. a startup probe).
 */
export { bwrap, buildBwrapArgs } from "./bwrap.js";
export type { BwrapOptions, MountEntry } from "./bwrap.js";
