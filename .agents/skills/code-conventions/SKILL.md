---
name: code-conventions
description: Review code against repo conventions for file structure, naming, types, and quality rules
---

## Table of contents

- File ordering, one module per file, colocated tests
- JSDoc and comment style (no banners, dividers, or history)
- Verb naming (create/resolve/build/ensure)
- Naming conventions (spell out, accurate, opts/ctx/err exceptions)
- Type conventions (canonical types, no any, Zod SSoT, `as const` unions, compose over extend)
- Request validation (Zod, no as casts, z.array().max())
- Testing (DI over mocking)
- Control flow (exhaustive switch + default throw)
- Simplification and correctness (delete dead code, defer to the tool, secrets, byte streams)
- Checklist for reviews

## When to use

- Reviewing a PR or branch for convention compliance.
- Writing new code and wanting to check conventions before committing.
- The user asks whether code matches project style.

## File ordering

Every file follows the same order: imports → constants → types → main export(s) → helper functions. The file's headline export leads; helpers sit below it.

**Good:**

```ts
import { z } from "zod";

const MAX_RETRIES = 3;

/**
 * Configuration for connecting to an external service.
 */
export interface ServiceConfig {
  url: string;
  timeoutMs: number;
}

/**
 * Create a service client from configuration.
 */
export function createServiceClient(config: ServiceConfig) {
  // ...
}

function buildRetryDelay(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}
```

**Bad:**

```ts
import { z } from "zod";

// helper at the top
function buildRetryDelay(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}

const MAX_RETRIES = 3;

export interface ServiceConfig {
  url: string;
  timeoutMs: number;
}

/** Single line comment in this style */
export function createServiceClient(config: ServiceConfig) {
  // ...
}
```

One module per file. A labeled divider separating two independent exportable units means the file should be **split**, not labeled. Colocate one test file per module (`foo.test.ts` beside `foo.ts`) and import the module directly, not through a barrel; when a module is split, split its test file the same way.

## Comments and JSDoc

Use multi-line JSDoc (`/** */`) for everything outside a function body — types, exported and module-level functions, constants. Use brief `//` comments only inside function bodies. Keep comments short: state the purpose or a non-obvious constraint, not narration. Design rationale belongs in `docs/`, not inline. No history references in comments.

**Good:**

```ts
/**
 * Connect to the upstream API. Retries up to 3 times with exponential backoff.
 */
export function connect(config: ServiceConfig) {
  // Retry immediately on 503 — the upstream drains connections briefly
  const backoff = status === 503 ? 0 : buildRetryDelay(attempt);
}
```

**Bad:**

```ts
// This function connects to the upstream API. We decided to use retries
// because the upstream was flaky in March 2024 and we didn't want to
// block users every time the service restarted.
function connect(config: ServiceConfig) {
  /* We multiply by 1000 to convert seconds to milliseconds */
  const backoff = Math.pow(2, attempt) * 1000;
}

/** Connect to the upstream API. Retries up to 3 times with exponential backoff. */
export function connect(config: ServiceConfig) {
  // Retry immediately on 503 — the upstream drains connections briefly
  const backoff = status === 503 ? 0 : buildRetryDelay(attempt);
}
```

Also:

- No top-of-file banner or summary comments — the file opens on its imports.
- No bare divider comments (`// -----` with no label).
- Keep JSDoc to a line or two that state the non-obvious; preserve the detail that changes a decision (a default, a cap's rationale, "a rejection fails the spawn").
- JSDoc must describe where the value actually flows — trace it to the field it lands on, not the option's name. Re-read copied JSDoc; it drifts.
- A token at a JSDoc line-start beginning with `@` is parsed as a tag — backtick package names (`` `@scope/pkg` ``).

## Verb naming

Use one verb per concept. Don't mix `create`/`build`/`make` for the same act.

| Verb       | Meaning                        |
| ---------- | ------------------------------ |
| `create*`  | Makes an object                |
| `resolve*` | Computes or looks up a value   |
| `build*`   | Assembles arguments or strings |
| `ensure*`  | Gets-or-throws                 |

**Good:**

```ts
export function createWorker(config: WorkerConfig): Worker {
  /* ... */
}
export function resolveHandler(route: string): Handler | null {
  /* ... */
}
export function buildQueryString(params: Record<string, string>): string {
  /* ... */
}
export function ensureUser(id: string): User {
  /* throws if not found */
}
```

**Bad:**

```ts
export function makeWorker(config: WorkerConfig): Worker {
  /* ... */
}
export function buildHandler(route: string): Handler | null {
  /* ... */
}
export function createQueryString(params: Record<string, string>): string {
  /* ... */
}
```

## Naming

Spell names out; avoid one-letter abbreviations when a full word exists. Use `opts` for option parameters, `ctx` for context, `err` for a caught error — consistently.

**Good:**

```ts
export function createSession(opts: SessionOpts): Session { /* ... */ }
export async function run(ctx: ExecutionContext) { /* ... */ }
catch (err) { /* ... */ }
```

**Bad:**

```ts
export function createSession(o: SessionOpts): Session { /* ... */ }
export async function run(context: ExecutionContext) { /* ... */ }
export async function run(c: ExecutionContext) { /* ... */ }
catch (e) { /* ... */ }
```

Also:

- Name a value for what it is — a decoded stream chunk is `text`, not `line`.
- Use British spellings in identifiers, comments, and docs: `-ise`/`-isation`, `behaviour`, `colour`, `serialise`, `catalogue`, `initialise`. Keep `cipher` (standard British English).
- Name a test double after the interface it implements, not the collaborator it imitates (`FakeRuntimeProcess`, not `FakePiProcess`), and name the whole family consistently.
- Name magic numbers that govern a limit or safety cap (`MAX_OUTPUT_BYTES`, not a bare `1 * 1024 * 1024`).

## Types

A type's name must make clear what it is and what owns it. Define one canonical type per concept and reuse it. Don't re-declare the same shape inline. No `any` types. Zod schemas are the single source of truth for data shapes — derive types with `z.infer<>`.

**Good:**

```ts
const SessionSchema = z.object({ source: z.string(), key: z.string() });
type SessionRef = z.infer<typeof SessionSchema>;

function handleSession(ref: SessionRef) {
  /* ... */
}
```

**Bad:**

```ts
// Duplicate interface instead of deriving from the schema
interface SessionRef {
  source: string;
  key: string;
}

const SessionSchema = z.object({ source: z.string(), key: z.string() });

function handleSession(ref: { source: string; key: string }) {
  /* ... */
}

function process(data: any) {
  /* ... */
}
```

Also:

- Express a closed set of string literals as a `const` array with `as const` plus a derived type. The `as const` is required — without it the array widens to `string[]` and the type collapses to `string`. Don't re-spell the union anywhere.
- Prefer **composing** types over merging them: give a value object or hook parameter a named field (`ref: SessionRef`) rather than intersecting (`… & SessionRef`) or extending it; extract inline parameter shapes into named interfaces. Deduping a pure options bag with `extends` is fine — it keeps one source of fields and one source of JSDoc.
- One canonical type per wire contract. A hand-copied "mirrors X" shape drifts — import it, or across a hard package boundary copy it deliberately and say why.
- Public-API vocabulary lives in the shared types module; a shape with one internal consumer lives with that consumer. A package's `index.ts` export list is the public/internal line.
- Type-only import cycles are safe (erased at compile time); a runtime-value cycle is not.
- Typing a callback `void | Promise<void>` loses TS's void-return leniency — concise arrows need `=> void expr` or braces. Accept that; the strictness documents that the result is awaited.

**Good:**

```ts
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
```

**Bad:**

```ts
// Widens to string[] — ThinkingLevel collapses to `string`
export const THINKING_LEVELS = ["off", "low", "medium", "high"];
// Union re-spelled by hand, drifts from the array above
export type ThinkingLevel = "off" | "low" | "medium" | "high";
```

## Request validation

Validate request bodies with Zod — no `as` casts. All `z.array()` user inputs must have `.max()`.

**Good:**

```ts
const CreateProjectSchema = z.object({
  name: z.string().min(1),
  tags: z.array(z.string()).max(50),
});

function handleCreate(req: Request) {
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(parsed.error);
  // parsed.data is fully typed
}
```

**Bad:**

```ts
function handleCreate(req: Request) {
  const body = req.body as { name: string; tags: string[] };
  // ...
}

const CreateProjectSchema = z.object({
  tags: z.array(z.string()), // no .max() — unbounded
});
```

## Testing

Prefer dependency injection over mocking. Inject collaborators (callbacks, ports) through the front door. Reserve mocks for true HTTP or external boundaries.

**Good:**

```ts
// Inject a fetch callback — test can supply a fake
export async function fetchConfig(url: string, fetchFn = fetch) {
  const res = await fetchFn(url);
  return res.json();
}

// Test
await fetchConfig("https://api.example.com", async () => Response.json({ key: "value" }));
```

**Bad:**

```ts
// Mocking the global fetch
jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ key: "value" }) as Response);
```

Also:

- Test a private helper through the public function that uses it — don't export internals to test them.
- One top-level `describe` per module, with themed sub-`describe`s nested under the aspect they exercise.
- Build a real minimal collaborator instead of an `as` cast for a test dependency. A non-null `arr[0]![0]` indexing into known-present call args is fine — it isn't an `as`.
- Exception to DI-over-mocking: spying on `console`/IO for a thin wrapper with no injectable seam is fine.

## Control flow

Consume a closed discriminated union with an exhaustive `switch` and a `default` that throws — not a ternary or `if`/`else` chain. The switch documents the closed set and fails loudly on an unhandled variant.

**Good:**

```ts
switch (caller.kind) {
  case "session":
    return describeSession(caller.ref);
  case "host":
    return "host";
  default:
    throw new Error(`Unknown caller kind: ${(caller as { kind: string }).kind}`);
}
```

**Bad:**

```ts
// Silently returns undefined-ish for an unhandled variant
return caller.kind === "session" ? describeSession(caller.ref) : "host";
```

Register a waiter before the event that can resolve it, so a fast event isn't dropped by a not-yet-registered listener (no lost-wakeup window).

When two switch cases would share a body but re-discriminate the kind inside it, give each case its own body — a little duplication beats a nested kind check.

## Checklist

When reviewing, check each item and report violations with file paths and line numbers:

- [ ] File ordering: imports → constants → types → main export → helpers
- [ ] One module per file; tests colocated, one per module, imported directly
- [ ] JSDoc on types, exports, and module-level functions
- [ ] Comments are short and purpose-focused; no banners, bare dividers, or history references
- [ ] Verb naming follows create/resolve/build/ensure conventions
- [ ] Names are spelled out (no abbreviations except opts/ctx/err) and accurate to what the thing is
- [ ] Types are canonical and reused (no inline duplicates); composed over intersected/extended where it's a value or param object
- [ ] Closed string-literal sets use a `const … as const` array + derived type
- [ ] No `any` types
- [ ] Zod schemas derive types via `z.infer<>`
- [ ] Request bodies validated with Zod (no `as` casts)
- [ ] `z.array()` has `.max()` on user inputs
- [ ] Public vocabulary in the shared types module; single-consumer shapes kept local
- [ ] Closed unions consumed with an exhaustive `switch` + `default` that throws
- [ ] Dead code, unused exports, and speculative abstractions removed
- [ ] Secrets never in argv or committed config
- [ ] Doc and JSDoc examples verified against the real API
- [ ] Tests use dependency injection, not mocks
