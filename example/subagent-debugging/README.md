# Debug nested subagents

Run the credential-free example from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir example/subagent-debugging start
```

It uses Pi 1.4.0 and `@tintinweb/pi-subagents` 0.22.0 with a scripted local model.
The parent awaits a child, which awaits a grandchild. Picco prints their IDs,
parent IDs, root session ID, outcomes and transcript paths:

```text
subagent.started  agentId=child      parentAgentId=null
subagent.started  agentId=grandchild parentAgentId=child
subagent.finished agentId=grandchild parentAgentId=child status=completed transcriptPath=...
subagent.finished agentId=child      parentAgentId=null  status=completed transcriptPath=...
```

Open the `transcriptPath` from a finished event to read the child's JSONL
conversation. Follow `parentAgentId` to its owner. A top-level child has a null
parent ID; `rootSessionId` identifies the Pi conversation that delegated the work.
The files remain under this example's ignored `workspace/` directory after the
worker stops. Transcripts contain full prompts, tool output and errors; treat
them as private data. These child log events contain selected metadata only.

On Linux with Bubblewrap installed, run the same example in a sandbox:

```sh
pnpm --dir example/subagent-debugging start --bwrap
```

The sandbox mounts the example's code dependencies read-only and keeps transcripts
in its writable workspace, rather than its temporary `/tmp`. On Fedora the example
also mounts the OpenSSL policy directory read-only so Node can start.

## Use the adapter in an assistant

Load `dist/observe-subagents.js` alongside the subagents extension. In the runtime's
`spawn` call, set `spec.env.PI_SUBAGENTS_OUTPUT_DIR` to an absolute writable directory
that survives the worker. The example uses `<spec.cwd>/subagent-transcripts` so paths
are also directly readable on the host with both local and Bubblewrap runtimes.
See [the complete example](src/index.ts).

The checked-in [dependency patch](../../patches/@tintinweb__pi-subagents@0.22.0.patch)
adds an all-depth metadata event and a configurable output directory. It leaves
delegation, settings inheritance, scheduling and cancellation with pi-subagents.
The workspace applies this patch to the pinned version; ordinary npm installations
of pi-subagents do not include it. This is an experiment, not an upstream release.

The output directory retains upstream's cwd/session/task layout. Workflow scripts
also use that directory when workflows are enabled. File retention belongs to the
host; this example does not delete prior runs or rotate files.

## Coverage and limits

The integration test executes real Pi and subagents with a scripted model. It
checks nested success and provider rejection, parent linkage, transcript contents
after shutdown and absence of conversation content from child log events:

```sh
pnpm exec vitest run integration/src/subagent-observability.test.ts
```

Start events can have a null transcript path because the file is attached later.
Early startup failures, queued cancellations and process crashes do not always
produce paired start/finish events. Transcript writes retain upstream's best-effort
behaviour. There is no execution database, failure classification or job recovery.
