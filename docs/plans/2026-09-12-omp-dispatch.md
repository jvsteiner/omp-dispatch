# omp-dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that dispatches bulk work to long-lived `omp` subagents over RPC, with two-way conversation, hard budget caps, and OS-level path locking.

**Architecture:** One TypeScript CLI (`bin/dispatch`) run by bun. `run` spawns a detached **broker** that owns an `omp --mode rpc` child via the bundled `RpcClient` and serves a unix socket inside the run directory. Later `dispatch` invocations are thin socket clients. All state lives on disk under `<workdir>/.omp-dispatch/runs/<run_id>/`, so a dead broker never loses a conversation — `say` falls back to `omp -r <session>`.

**Tech Stack:** bun 1.4.0, TypeScript, `bun:test`, `@oh-my-pi/pi-coding-agent`'s `RpcClient`, unix domain sockets, git plumbing, `chmod`.

**Spec:** `docs/specs/2026-09-12-omp-dispatch-design.md`

## Deliberate deviation from the spec

The spec says `bin/dispatch` is bash and only the broker is TypeScript. **This plan makes the whole tool TypeScript on bun.** Bun is already a hard requirement for the broker, and a second language buys nothing but shell-quoting bugs around JSON. `Bun.$` runs `chmod`, `git` and `omp models` as easily as bash would, and `bun:test` gives the preflight logic real tests that bash would not.

Nothing else departs from the spec.

## Global Constraints

- **bun ≥ 1.4.0.** Verified present at `/Users/jamie/.bun/bin/bun`.
- **omp ≥ 18.1.17.** Verified present at `/Users/jamie/.bun/bin/omp`.
- **Platforms: macOS and Linux.** Unix sockets and `chmod` only. No Windows.
- **No test may call a model provider**, except the single smoke test in Task 11. Every other test runs against `test/fake-omp.ts`.
- **Counts and cost come from `getSessionStats()`.** Never parse session JSONL. Never count frames to produce a number.
- **`files_changed` comes from git.** Never from the agent.
- **Turn completion is `agent_end` with `isTerminal !== false`.** A frame with `isTerminal: false` is not a completed turn.
- **RPC mode rejects `@file` argv.** The task body is delivered as an RPC `prompt`.
- Run state lives at `<workdir>/.omp-dispatch/`, gitignored.
- Defaults: `max_turns: 120`, `max_usd: 1.00`, `max_seconds: 3300`, `tools: read,write,edit,bash`.

---

### Task 1: Repository skeleton and the task-file parser

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/taskfile.ts`
- Create: `roles/ingest.md`
- Test: `test/taskfile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export interface TaskSpec {
  model: string;          // "provider/id" or bare id
  workdir: string;        // absolute path
  readonly: string[];     // paths relative to workdir
  tools: string;          // comma-separated allowlist
  maxTurns: number;
  maxUsd: number;
  maxSeconds: number;
  role?: string;
  body: string;           // the prompt
}
export const TASK_DEFAULTS: Omit<TaskSpec, "model" | "workdir" | "body">;
export function parseTaskFile(
  text: string,
  opts: { taskPath: string; rolesDir: string }
): TaskSpec;
```

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "omp-dispatch",
  "private": true,
  "type": "module",
  "bin": { "dispatch": "./bin/dispatch" },
  "devDependencies": { "@types/bun": "latest" }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.omp-dispatch/
*.log
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun-types"],
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

- [ ] **Step 4: Write the failing tests**

Create `test/taskfile.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseTaskFile, TASK_DEFAULTS } from "../src/taskfile.ts";

const opts = { taskPath: "/tmp/t.md", rolesDir: "/tmp/roles" };

test("parses front matter and body", () => {
  const spec = parseTaskFile(
    `---\nmodel: deepseek/deepseek-v4-flash\nworkdir: /tmp/w\nmax_usd: 2.5\n---\nDo the thing.\n`,
    opts,
  );
  expect(spec.model).toBe("deepseek/deepseek-v4-flash");
  expect(spec.workdir).toBe("/tmp/w");
  expect(spec.maxUsd).toBe(2.5);
  expect(spec.body).toBe("Do the thing.");
});

test("applies defaults for omitted keys", () => {
  const spec = parseTaskFile(`---\nmodel: m\nworkdir: /tmp/w\n---\nbody\n`, opts);
  expect(spec.maxTurns).toBe(TASK_DEFAULTS.maxTurns);
  expect(spec.maxSeconds).toBe(TASK_DEFAULTS.maxSeconds);
  expect(spec.tools).toBe(TASK_DEFAULTS.tools);
  expect(spec.readonly).toEqual([]);
});

test("parses a readonly list", () => {
  const spec = parseTaskFile(
    `---\nmodel: m\nworkdir: /tmp/w\nreadonly: [raw, schema, CLAUDE.md]\n---\nbody\n`,
    opts,
  );
  expect(spec.readonly).toEqual(["raw", "schema", "CLAUDE.md"]);
});

test("rejects a missing model", () => {
  expect(() => parseTaskFile(`---\nworkdir: /tmp/w\n---\nbody\n`, opts)).toThrow(/model/);
});

test("rejects a relative workdir", () => {
  expect(() => parseTaskFile(`---\nmodel: m\nworkdir: rel\n---\nbody\n`, opts)).toThrow(/absolute/);
});

test("rejects an empty body", () => {
  expect(() => parseTaskFile(`---\nmodel: m\nworkdir: /tmp/w\n---\n\n`, opts)).toThrow(/body/);
});

test("rejects a file with no front matter", () => {
  expect(() => parseTaskFile(`just a prompt`, opts)).toThrow(/front matter/);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `bun test test/taskfile.test.ts`
Expected: FAIL — cannot resolve `../src/taskfile.ts`

- [ ] **Step 6: Implement `src/taskfile.ts`**

Front matter is a deliberately small subset: `key: value` and `key: [a, b, c]`. No nested YAML, because nothing in `TaskSpec` needs it. Do not add a YAML dependency.

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TaskSpec {
  model: string;
  workdir: string;
  readonly: string[];
  tools: string;
  maxTurns: number;
  maxUsd: number;
  maxSeconds: number;
  role?: string;
  body: string;
}

export const TASK_DEFAULTS = {
  readonly: [] as string[],
  tools: "read,write,edit,bash",
  maxTurns: 120,
  maxUsd: 1.0,
  maxSeconds: 3300,
};

const KEY_MAP: Record<string, string> = {
  model: "model",
  workdir: "workdir",
  readonly: "readonly",
  tools: "tools",
  max_turns: "maxTurns",
  max_usd: "maxUsd",
  max_seconds: "maxSeconds",
  role: "role",
};

function splitFrontMatter(text: string): { head: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("task file has no front matter (expected a --- block at the top)");
  return { head: m[1]!, body: m[2]!.trim() };
}

function parseHead(head: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const raw of head.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) throw new Error(`bad front-matter line: ${raw}`);
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!(key in KEY_MAP)) throw new Error(`unknown front-matter key: ${key}`);
    out[KEY_MAP[key]!] =
      value.startsWith("[") && value.endsWith("]")
        ? value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean)
        : value;
  }
  return out;
}

export function parseTaskFile(
  text: string,
  opts: { taskPath: string; rolesDir: string },
): TaskSpec {
  const { head, body } = splitFrontMatter(text);
  let fields = parseHead(head);

  // A role supplies defaults underneath; the task file's own keys win.
  const roleName = fields.role;
  if (typeof roleName === "string") {
    const rolePath = join(opts.rolesDir, `${roleName}.md`);
    if (!existsSync(rolePath)) throw new Error(`unknown role: ${roleName} (${rolePath})`);
    const roleHead = splitFrontMatter(readFileSync(rolePath, "utf8")).head;
    fields = { ...parseHead(roleHead), ...fields };
  }

  const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : undefined);
  const num = (k: string, d: number) => {
    const v = str(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} must be a positive number`);
    return n;
  };

  const model = str("model");
  if (!model) throw new Error("task file must set model");
  const workdir = str("workdir");
  if (!workdir) throw new Error("task file must set workdir");
  if (!workdir.startsWith("/")) throw new Error("workdir must be an absolute path");
  if (!body) throw new Error("task file must have a body (the prompt)");

  return {
    model,
    workdir,
    readonly: Array.isArray(fields.readonly) ? fields.readonly : TASK_DEFAULTS.readonly,
    tools: str("tools") ?? TASK_DEFAULTS.tools,
    maxTurns: num("maxTurns", TASK_DEFAULTS.maxTurns),
    maxUsd: num("maxUsd", TASK_DEFAULTS.maxUsd),
    maxSeconds: num("maxSeconds", TASK_DEFAULTS.maxSeconds),
    role: roleName as string | undefined,
    body,
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/taskfile.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 8: Add a role test and `roles/ingest.md`**

Create `roles/ingest.md`:

```markdown
---
tools: read,write,edit,bash
max_turns: 150
max_usd: 2.00
---

Reference role for bulk document ingest. A task file that sets `role: ingest`
inherits these caps and may override any of them.
```

Append to `test/taskfile.test.ts`:

```ts
test("a role supplies defaults and the task file overrides them", () => {
  const spec = parseTaskFile(
    `---\nmodel: m\nworkdir: /tmp/w\nrole: ingest\nmax_usd: 0.25\n---\nbody\n`,
    { taskPath: "/tmp/t.md", rolesDir: `${import.meta.dir}/../roles` },
  );
  expect(spec.maxTurns).toBe(150);   // from the role
  expect(spec.maxUsd).toBe(0.25);    // task file wins
});
```

- [ ] **Step 9: Run tests**

Run: `bun test test/taskfile.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json .gitignore src/taskfile.ts roles/ingest.md test/taskfile.test.ts
git commit -m "feat(taskfile): parse task files and merge role defaults"
```

---

### Task 2: Preflight — provider guard, path locking, git snapshot

**Files:**
- Create: `src/preflight.ts`
- Test: `test/preflight.test.ts`

**Interfaces:**
- Consumes: `TaskSpec` from Task 1.
- Produces:
```ts
export function assertProviderHasModel(model: string, catalogue: string): void;
export async function unlockPaths(workdir: string, rel: string[]): Promise<void>;
export async function lockPaths(workdir: string, rel: string[]): Promise<void>;
export async function gitSnapshot(workdir: string): Promise<string[] | null>;
export async function gitChangedSince(workdir: string, before: string[] | null): Promise<string[]>;
export async function readModelCatalogue(): Promise<string>;
```

**Why the guard is not optional:** omp matches model ids fuzzily. With no key for the named provider it silently routes to another provider's copy — a real incident in the reference project, which sent a probe through OpenRouter unnoticed. Check the **catalogue**, never by sending a prompt: the first version of that guard sent `"ok"`, which the agent treated as a task and answered by browsing the filesystem.

`assertProviderHasModel` takes the catalogue text as an argument so it is testable without spawning anything.

- [ ] **Step 1: Write the failing tests**

Create `test/preflight.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProviderHasModel, lockPaths, unlockPaths, gitSnapshot, gitChangedSince,
} from "../src/preflight.ts";

// `omp models` prints a provider header line, then its models indented.
const CATALOGUE = [
  "deepseek (2)",
  "  deepseek-v4-flash",
  "  deepseek-v4",
  "openrouter (1)",
  "  deepseek/deepseek-v4-flash",
].join("\n");

test("accepts a model listed under its named provider", () => {
  expect(() => assertProviderHasModel("deepseek/deepseek-v4-flash", CATALOGUE)).not.toThrow();
});

test("rejects a model that only exists under another provider", () => {
  expect(() => assertProviderHasModel("cerebras/deepseek-v4-flash", CATALOGUE))
    .toThrow(/cerebras/);
});

test("skips the check when no provider is named", () => {
  expect(() => assertProviderHasModel("deepseek-v4-flash", CATALOGUE)).not.toThrow();
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-dispatch-"));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "raw", "a.txt"), "a");
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  return dir;
}

test("lock makes paths read-only and unlock restores them", async () => {
  const dir = fixture();
  await lockPaths(dir, ["raw", "CLAUDE.md"]);
  expect(statSync(join(dir, "raw", "a.txt")).mode & 0o200).toBe(0);
  await unlockPaths(dir, ["raw", "CLAUDE.md"]);
  expect(statSync(join(dir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
});

test("unlock repairs paths left locked by a previous kill -9", async () => {
  const dir = fixture();
  await lockPaths(dir, ["raw"]);
  await unlockPaths(dir, ["raw"]);   // stands in for the repair at the top of a run
  await unlockPaths(dir, ["raw"]);   // idempotent
  expect(statSync(join(dir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
});

test("lock ignores a path that does not exist", async () => {
  const dir = fixture();
  await expect(lockPaths(dir, ["nope"])).resolves.toBeUndefined();
});

test("git snapshot and diff report only what the run changed", async () => {
  const dir = fixture();
  await Bun.$`git init -q`.cwd(dir);
  await Bun.$`git add -A`.cwd(dir);
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  const before = await gitSnapshot(dir);
  writeFileSync(join(dir, "new.md"), "x");
  const changed = await gitChangedSince(dir, before);
  expect(changed).toEqual(["new.md"]);
});

test("git snapshot returns null outside a repo", async () => {
  expect(await gitSnapshot(fixture())).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/preflight.test.ts`
Expected: FAIL — cannot resolve `../src/preflight.ts`

- [ ] **Step 3: Implement `src/preflight.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * omp matches model ids fuzzily and will route "deepseek/x" through another
 * provider's copy when the named provider has no key. Assert against the
 * catalogue, never by sending a prompt.
 */
export function assertProviderHasModel(model: string, catalogue: string): void {
  const slash = model.indexOf("/");
  if (slash < 0) return;                       // no provider named; nothing to assert
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);

  let current = "";
  for (const line of catalogue.split("\n")) {
    const header = /^([a-z0-9-]+) \(\d+\)$/.exec(line.trim());
    if (header && !line.startsWith(" ")) { current = header[1]!; continue; }
    if (current === provider && line.includes(id)) return;
  }
  throw new Error(
    `provider '${provider}' does not list model '${id}'.\n` +
    `Usually a missing API key. omp would fall back to another provider's copy ` +
    `without saying so. Refusing to run down a route that was not chosen.`,
  );
}

export async function readModelCatalogue(): Promise<string> {
  return (await Bun.$`omp models`.nothrow().text()) ?? "";
}

function present(workdir: string, rel: string[]): string[] {
  return rel.map(r => join(workdir, r)).filter(p => existsSync(p));
}

/** Make paths read-only at the OS level, before any model exists. */
export async function lockPaths(workdir: string, rel: string[]): Promise<void> {
  for (const p of present(workdir, rel)) await Bun.$`chmod -R a-w ${p}`.nothrow().quiet();
}

/**
 * Restore write permission. Run this at the START of every dispatch too: a
 * previous run killed with -9 never ran its exit trap and left the paths
 * unwritable. Clearing it first stops a stuck state compounding.
 */
export async function unlockPaths(workdir: string, rel: string[]): Promise<void> {
  for (const p of present(workdir, rel)) await Bun.$`chmod -R u+w ${p}`.nothrow().quiet();
}

async function isRepo(workdir: string): Promise<boolean> {
  const r = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(workdir).nothrow().quiet();
  return r.exitCode === 0;
}

function parsePorcelain(text: string): string[] {
  return text.split("\n").map(l => l.slice(3).trim()).filter(Boolean).sort();
}

/** Returns the dirty-file list, or null when workdir is not a git repo. */
export async function gitSnapshot(workdir: string): Promise<string[] | null> {
  if (!await isRepo(workdir)) return null;
  return parsePorcelain(await Bun.$`git status --porcelain`.cwd(workdir).text());
}

/** Files dirty now that were not dirty before. Never trust the agent for this. */
export async function gitChangedSince(
  workdir: string,
  before: string[] | null,
): Promise<string[]> {
  if (before === null) return [];
  const after = parsePorcelain(await Bun.$`git status --porcelain`.cwd(workdir).text());
  const was = new Set(before);
  return after.filter(f => !was.has(f));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/preflight.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/preflight.ts test/preflight.test.ts
git commit -m "feat(preflight): provider guard, OS-level path locking, git-based change detection"
```

---

### Task 3: Run directory and `result.json`

**Files:**
- Create: `src/rundir.ts`
- Test: `test/rundir.test.ts`

**Interfaces:**
- Consumes: `TaskSpec` (Task 1).
- Produces:
```ts
export type RunState = "running" | "asking" | "completed" | "capped" | "aborted" | "error";
export type StoppedBecause =
  | "completed" | "max_turns" | "max_usd" | "max_seconds"
  | "aborted" | "error" | "asking" | null;

export interface RunResult {
  run_id: string;
  state: RunState;
  stopped_because: StoppedBecause;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  seconds: number;
  model: { provider: string; id: string } | null;
  session_file: string | null;
  files_changed: string[];
  last_reply: string | null;
  ask: { ask_id: string; question: string; context?: string } | null;
}

export function newRunId(): string;
export function runsRoot(workdir: string): string;
export function runDirFor(workdir: string, runId: string): string;
export function createRunDir(workdir: string, runId: string): string;
export function writeResult(runDir: string, r: RunResult): void;
export function readResult(runDir: string): RunResult;
export function emptyResult(runId: string): RunResult;
export function isAlive(runDir: string): boolean;
export function listRuns(workdir: string): Array<{ runId: string; dir: string; result: RunResult; alive: boolean }>;
export function appendProgress(runDir: string, line: string): void;
```

- [ ] **Step 1: Write the failing tests**

Create `test/rundir.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId, createRunDir, writeResult, readResult, emptyResult,
  listRuns, isAlive, appendProgress, runDirFor,
} from "../src/rundir.ts";

const wd = () => mkdtempSync(join(tmpdir(), "omp-run-"));

test("run ids are unique and sort chronologically", () => {
  const ids = [newRunId(), newRunId(), newRunId()];
  expect(new Set(ids).size).toBe(3);
  expect([...ids].sort()).toEqual(ids);
});

test("creates the run directory under the workdir", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  expect(dir).toBe(runDirFor(w, id));
  expect(existsSync(dir)).toBe(true);
});

test("result round-trips", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  const r = { ...emptyResult(id), turns: 7, cost_usd: 0.16, state: "completed" as const };
  writeResult(dir, r);
  expect(readResult(dir).turns).toBe(7);
  expect(readResult(dir).cost_usd).toBe(0.16);
});

test("a run with no pidfile is not alive", () => {
  const w = wd(); const id = newRunId();
  writeResult(createRunDir(w, id), emptyResult(id));
  expect(isAlive(runDirFor(w, id))).toBe(false);
});

test("a run whose pid is this process is alive", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  writeResult(dir, emptyResult(id));
  writeFileSync(join(dir, "broker.pid"), String(process.pid));
  expect(isAlive(dir)).toBe(true);
});

test("a run whose pid is dead is not alive", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  writeResult(dir, emptyResult(id));
  writeFileSync(join(dir, "broker.pid"), "999999");
  expect(isAlive(dir)).toBe(false);
});

test("listRuns returns newest first with liveness", () => {
  const w = wd();
  const a = newRunId(); const b = newRunId();
  writeResult(createRunDir(w, a), emptyResult(a));
  writeResult(createRunDir(w, b), emptyResult(b));
  const runs = listRuns(w);
  expect(runs.map(r => r.runId)).toEqual([b, a]);
  expect(runs[0]!.alive).toBe(false);
});

test("listRuns is empty for a workdir that never ran anything", () => {
  expect(listRuns(wd())).toEqual([]);
});

test("progress lines are appended with an elapsed prefix", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  appendProgress(dir, "read foo.md");
  appendProgress(dir, "write bar.md");
  const log = readFileSync(join(dir, "progress.log"), "utf8");
  expect(log.split("\n").filter(Boolean).length).toBe(2);
  expect(log).toContain("read foo.md");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/rundir.test.ts`
Expected: FAIL — cannot resolve `../src/rundir.ts`

- [ ] **Step 3: Implement `src/rundir.ts`**

```ts
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync,
} from "node:fs";
import { join } from "node:path";

export type RunState = "running" | "asking" | "completed" | "capped" | "aborted" | "error";
export type StoppedBecause =
  | "completed" | "max_turns" | "max_usd" | "max_seconds"
  | "aborted" | "error" | "asking" | null;

export interface RunResult {
  run_id: string;
  state: RunState;
  stopped_because: StoppedBecause;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  seconds: number;
  model: { provider: string; id: string } | null;
  session_file: string | null;
  files_changed: string[];
  last_reply: string | null;
  ask: { ask_id: string; question: string; context?: string } | null;
}

let counter = 0;

/** Sorts chronologically as a plain string; the counter breaks same-millisecond ties. */
export function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${t}-${(counter++).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export const runsRoot = (workdir: string) => join(workdir, ".omp-dispatch", "runs");
export const runDirFor = (workdir: string, runId: string) => join(runsRoot(workdir), runId);

export function createRunDir(workdir: string, runId: string): string {
  const dir = runDirFor(workdir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function emptyResult(runId: string): RunResult {
  return {
    run_id: runId, state: "running", stopped_because: null,
    turns: 0, tool_calls: 0, cost_usd: 0, seconds: 0,
    model: null, session_file: null, files_changed: [], last_reply: null, ask: null,
  };
}

export function writeResult(runDir: string, r: RunResult): void {
  // Write-then-rename so a reader never sees a half-written file.
  const tmp = join(runDir, "result.json.tmp");
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  Bun.spawnSync(["mv", tmp, join(runDir, "result.json")]);
}

export function readResult(runDir: string): RunResult {
  return JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as RunResult;
}

export function isAlive(runDir: string): boolean {
  const pidFile = join(runDir, "broker.pid");
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function listRuns(workdir: string) {
  const root = runsRoot(workdir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort().reverse()                       // run ids sort chronologically
    .filter(id => existsSync(join(root, id, "result.json")))
    .map(id => {
      const dir = join(root, id);
      return { runId: id, dir, result: readResult(dir), alive: isAlive(dir) };
    });
}

const started = new Map<string, number>();

export function appendProgress(runDir: string, line: string): void {
  if (!started.has(runDir)) started.set(runDir, Date.now());
  const secs = Math.round((Date.now() - started.get(runDir)!) / 1000);
  appendFileSync(join(runDir, "progress.log"), `[${String(secs).padStart(4)}s] ${line}\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/rundir.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/rundir.ts test/rundir.test.ts
git commit -m "feat(rundir): run directory layout, result.json, liveness and progress log"
```

---

### Task 4: The fake omp, and the broker's cap logic

The broker is the riskiest component, so it is built against a test double first. `test/fake-omp.ts` speaks enough of omp's RPC protocol to drive every path — caps, asks, aborts — offline and for free.

**Files:**
- Create: `test/fake-omp.ts`
- Create: `src/caps.ts`
- Test: `test/caps.test.ts`

**Interfaces:**
- Consumes: `RunResult` (Task 3), `TaskSpec` (Task 1).
- Produces:
```ts
// src/caps.ts
export interface CapState { turns: number; costUsd: number; startedAt: number; }
export interface Caps { maxTurns: number; maxUsd: number; maxSeconds: number; }
export function newCapState(now?: number): CapState;
/** Call on every agent_end frame. Returns true when the turn counted. */
export function countTurn(s: CapState, frame: { isTerminal?: boolean }): boolean;
export function breach(s: CapState, c: Caps, now?: number): StoppedBecause | null;
```

- [ ] **Step 1: Write the failing tests**

Create `test/caps.test.ts`:

```ts
import { test, expect } from "bun:test";
import { newCapState, countTurn, breach } from "../src/caps.ts";

const CAPS = { maxTurns: 3, maxUsd: 1.0, maxSeconds: 100 };

test("a terminal agent_end counts as a turn", () => {
  const s = newCapState(0);
  expect(countTurn(s, { isTerminal: true })).toBe(true);
  expect(s.turns).toBe(1);
});

test("an agent_end with isTerminal absent counts (older runtimes)", () => {
  const s = newCapState(0);
  expect(countTurn(s, {})).toBe(true);
  expect(s.turns).toBe(1);
});

test("isTerminal:false does NOT count - maintenance scheduled more work", () => {
  const s = newCapState(0);
  expect(countTurn(s, { isTerminal: false })).toBe(false);
  expect(s.turns).toBe(0);
});

test("no breach inside every cap", () => {
  const s = newCapState(0); s.turns = 2; s.costUsd = 0.5;
  expect(breach(s, CAPS, 50_000)).toBeNull();
});

test("turn cap breaches at the limit", () => {
  const s = newCapState(0); s.turns = 3;
  expect(breach(s, CAPS, 0)).toBe("max_turns");
});

test("budget cap breaches at the limit", () => {
  const s = newCapState(0); s.costUsd = 1.0;
  expect(breach(s, CAPS, 0)).toBe("max_usd");
});

test("time cap breaches after the limit", () => {
  const s = newCapState(0);
  expect(breach(s, CAPS, 100_001)).toBe("max_seconds");
});

test("budget is reported before turns when both breach", () => {
  const s = newCapState(0); s.turns = 9; s.costUsd = 9;
  expect(breach(s, CAPS, 0)).toBe("max_usd");   // money is the one that hurts
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/caps.test.ts`
Expected: FAIL — cannot resolve `../src/caps.ts`

- [ ] **Step 3: Implement `src/caps.ts`**

```ts
import type { StoppedBecause } from "./rundir.ts";

export interface CapState { turns: number; costUsd: number; startedAt: number; }
export interface Caps { maxTurns: number; maxUsd: number; maxSeconds: number; }

export const newCapState = (now = Date.now()): CapState =>
  ({ turns: 0, costUsd: 0, startedAt: now });

/**
 * omp emits agent_end with isTerminal:false when maintenance or async delivery
 * has scheduled more work — the session will resume. That is not a completed
 * turn. The field is optional, so an absent one is terminal.
 */
export function countTurn(s: CapState, frame: { isTerminal?: boolean }): boolean {
  if (frame.isTerminal === false) return false;
  s.turns += 1;
  return true;
}

export function breach(s: CapState, c: Caps, now = Date.now()): StoppedBecause | null {
  if (s.costUsd >= c.maxUsd) return "max_usd";
  if (s.turns >= c.maxTurns) return "max_turns";
  if ((now - s.startedAt) / 1000 > c.maxSeconds) return "max_seconds";
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/caps.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Write the fake omp**

Create `test/fake-omp.ts`. It reads RPC commands on stdin and writes frames on stdout, exactly as `omp --mode rpc` does. Behaviour is driven by `FAKE_OMP_SCRIPT`, a JSON env var, so each test drives a different scenario.

```ts
#!/usr/bin/env bun
/**
 * A stand-in for `omp --mode rpc`. Speaks enough of the protocol for the
 * broker to be tested with no provider, no network and no money.
 *
 * FAKE_OMP_SCRIPT is JSON:
 *   { turnCostUsd, toolCallsPerTurn, replies: string[],
 *     nonTerminalFirst: boolean, askOnTurn: number | null }
 */
const script = JSON.parse(process.env.FAKE_OMP_SCRIPT ?? "{}");
const turnCostUsd: number = script.turnCostUsd ?? 0.01;
const toolCallsPerTurn: number = script.toolCallsPerTurn ?? 2;
const replies: string[] = script.replies ?? ["done"];
const nonTerminalFirst: boolean = script.nonTerminalFirst ?? false;
const askOnTurn: number | null = script.askOnTurn ?? null;

let turns = 0;
let cost = 0;
let toolCalls = 0;
let hostTools: Array<{ name: string }> = [];

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({
  type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
});

function stats() {
  return {
    sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake",
    userMessages: turns, assistantMessages: turns,
    toolCalls, toolResults: toolCalls, totalMessages: turns * 2,
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
    premiumRequests: 0, cost,
  };
}

async function runTurn() {
  turns += 1;
  out({ type: "agent_start" });

  if (askOnTurn === turns && hostTools.some(t => t.name === "ask_supervisor")) {
    out({
      type: "host_tool_call", id: `host_${turns}`, toolCallId: `toolu_${turns}`,
      toolName: "ask_supervisor",
      arguments: { question: "Which page wins when two disagree?" },
    });
    return;   // the turn parks until host_tool_result arrives
  }

  for (let i = 0; i < toolCallsPerTurn; i++) {
    toolCalls += 1;
    out({
      type: "message_update",
      assistantMessageEvent: { type: "tool_start", name: "read", input: { path: `f${i}.md` } },
      message: { role: "assistant", content: [] },
    });
  }
  cost += turnCostUsd;

  if (nonTerminalFirst && turns === 1) {
    out({ type: "agent_end", messages: [], isTerminal: false });   // must NOT count
  }
  out({ type: "agent_end", messages: [], isTerminal: true });
}

for await (const line of console) {
  if (!line.trim()) continue;
  let cmd: any;
  try { cmd = JSON.parse(line); } catch {
    out({ type: "response", command: "parse", success: false, error: "bad json" });
    continue;
  }
  const ok = (data?: unknown) =>
    out({ id: cmd.id, type: "response", command: cmd.type, success: true, data });

  switch (cmd.type) {
    case "negotiate_protocol": ok({ protocolVersion: cmd.protocolVersion }); break;
    case "set_host_tools":
      hostTools = cmd.tools ?? [];
      ok({ toolNames: hostTools.map(t => t.name) });
      break;
    case "get_state":
      ok({ model: { provider: "fake", id: "fake-1" }, isStreaming: false,
           sessionFile: "/tmp/fake-session.jsonl", dumpTools: [] });
      break;
    case "get_session_stats": ok(stats()); break;
    case "get_last_assistant_text": ok({ text: replies[Math.min(turns, replies.length) - 1] ?? "done" }); break;
    case "host_tool_result":
      ok();
      cost += turnCostUsd;
      out({ type: "agent_end", messages: [], isTerminal: true });
      break;
    case "prompt": case "follow_up": case "steer":
      ok({ agentInvoked: true });
      void runTurn();
      break;
    case "abort":
      ok();
      out({ type: "agent_end", messages: [], isTerminal: true });
      break;
    default: ok();
  }
}
```

- [ ] **Step 6: Verify the fake speaks the protocol**

Create `test/fake-omp.test.ts`:

```ts
import { test, expect } from "bun:test";

test("the fake emits a ready frame and answers get_session_stats", async () => {
  const p = Bun.spawn(["bun", `${import.meta.dir}/fake-omp.ts`], {
    stdin: "pipe", stdout: "pipe",
    env: { ...process.env, FAKE_OMP_SCRIPT: JSON.stringify({ turnCostUsd: 0.25 }) },
  });
  p.stdin.write(`${JSON.stringify({ id: "1", type: "get_session_stats" })}\n`);
  const reader = p.stdout.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  const frames = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
  expect(frames[0].type).toBe("ready");
  p.kill();
});
```

Run: `bun test test/fake-omp.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/caps.ts test/caps.test.ts test/fake-omp.ts test/fake-omp.test.ts
git commit -m "feat(caps): turn and budget cap logic, plus an offline omp test double"
```

---

### Task 5: The broker

**Files:**
- Create: `src/broker.ts`
- Test: `test/broker.test.ts`

**Interfaces:**
- Consumes: `TaskSpec`, `RunResult`, `CapState`, `Caps`, preflight helpers.
- Produces:
```ts
export interface BrokerOptions {
  task: TaskSpec;
  runDir: string;
  runId: string;
  /** Override the agent launcher. Tests point this at test/fake-omp.ts. */
  command?: string[];
  cliPath?: string;
}
export async function runBroker(opts: BrokerOptions): Promise<RunResult>;
```

The broker:

1. Writes `broker.pid`.
2. Builds an `RpcClient` with the empty `CLAUDE_CONFIG_DIR`, the tool allowlist, and `ask_supervisor` as a custom tool (wired in Task 9; registered as an empty list until then).
3. Subscribes to session events; writes every frame to `events.jsonl` and a readable line to `progress.log`.
4. On each `agent_end`, calls `countTurn`, then `getSessionStats()` for `cost` and `toolCalls`, then `breach()`.
5. On breach: `abort()`, wait, `stop()`, write `result.json` with the reason.
6. Serves the unix socket (Task 6).
7. On exit, always unlocks paths and computes `files_changed` from git.

- [ ] **Step 1: Write the failing tests**

Create `test/broker.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBroker } from "../src/broker.ts";
import { newRunId, createRunDir } from "../src/rundir.ts";
import type { TaskSpec } from "../src/taskfile.ts";

function setup(script: object, over: Partial<TaskSpec> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "omp-broker-"));
  const runId = newRunId();
  const runDir = createRunDir(workdir, runId);
  const task: TaskSpec = {
    model: "fake/fake-1", workdir, readonly: [], tools: "read",
    maxTurns: 120, maxUsd: 1.0, maxSeconds: 300, body: "do it", ...over,
  };
  process.env.FAKE_OMP_SCRIPT = JSON.stringify(script);
  return { task, runDir, runId, command: ["bun", `${import.meta.dir}/fake-omp.ts`] };
}

test("a clean run completes and records cost and tool calls", async () => {
  const s = setup({ turnCostUsd: 0.02, toolCallsPerTurn: 3, replies: ["all done"] });
  const r = await runBroker(s);
  expect(r.state).toBe("completed");
  expect(r.stopped_because).toBe("completed");
  expect(r.turns).toBe(1);
  expect(r.tool_calls).toBe(3);
  expect(r.cost_usd).toBeCloseTo(0.02, 5);
  expect(r.last_reply).toBe("all done");
}, 30_000);

test("a non-terminal agent_end does not count as a turn", async () => {
  const s = setup({ nonTerminalFirst: true });
  const r = await runBroker(s);
  expect(r.turns).toBe(1);
}, 30_000);

test("the budget cap stops the run", async () => {
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0 });
  const r = await runBroker(s);
  expect(r.state).toBe("capped");
  expect(r.stopped_because).toBe("max_usd");
}, 30_000);

test("the turn cap stops the run", async () => {
  const s = setup({ turnCostUsd: 0.0 }, { maxTurns: 1 });
  const r = await runBroker(s);
  expect(r.stopped_because).toBe("max_turns");
}, 30_000);

test("locked paths are restored even when a cap fires", async () => {
  const { mkdirSync, writeFileSync, statSync } = await import("node:fs");
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0, readonly: ["raw"] });
  mkdirSync(join(s.task.workdir, "raw"));
  writeFileSync(join(s.task.workdir, "raw", "a.txt"), "a");
  await runBroker(s);
  expect(statSync(join(s.task.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

test("every frame is written to events.jsonl", async () => {
  const { readFileSync } = await import("node:fs");
  const s = setup({});
  await runBroker(s);
  const lines = readFileSync(join(s.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every(l => JSON.parse(l))).toBe(true);
}, 30_000);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/broker.test.ts`
Expected: FAIL — cannot resolve `../src/broker.ts`

- [ ] **Step 3: Implement `src/broker.ts`**

```ts
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { TaskSpec } from "./taskfile.ts";
import {
  type RunResult, emptyResult, writeResult, appendProgress,
} from "./rundir.ts";
import { newCapState, countTurn, breach, type Caps } from "./caps.ts";
import { lockPaths, unlockPaths, gitSnapshot, gitChangedSince } from "./preflight.ts";

export interface BrokerOptions {
  task: TaskSpec;
  runDir: string;
  runId: string;
  command?: string[];
  cliPath?: string;
}

const OMP_CLI =
  "/Users/jamie/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";

export async function runBroker(opts: BrokerOptions): Promise<RunResult> {
  const { task, runDir, runId } = opts;
  const result = emptyResult(runId);
  const caps: Caps = {
    maxTurns: task.maxTurns, maxUsd: task.maxUsd, maxSeconds: task.maxSeconds,
  };
  const state = newCapState();

  writeFileSync(join(runDir, "broker.pid"), String(process.pid));
  writeResult(runDir, result);

  // An empty CLAUDE_CONFIG_DIR is free insurance; --tools= is what actually
  // shrinks the surface. See spec section 15.
  const emptyConfig = join(runDir, "no-claude-config");
  mkdirSync(emptyConfig, { recursive: true });

  // Repair a stale lock from a previous kill -9, then lock for this run.
  await unlockPaths(task.workdir, task.readonly);
  const before = await gitSnapshot(task.workdir);
  await lockPaths(task.workdir, task.readonly);

  const [provider, id] = task.model.includes("/")
    ? task.model.split("/") as [string, string]
    : [undefined, task.model];

  const client = new RpcClient({
    cliPath: opts.cliPath ?? OMP_CLI,
    command: opts.command,
    cwd: task.workdir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: emptyConfig } as Record<string, string>,
    provider, model: id,
    args: [
      `--tools=${task.tools}`,
      "--no-skills", "--no-rules", "--no-extensions", "--no-lsp", "--no-pty",
      `--max-time=${task.maxSeconds}`,
    ],
  });

  let settled: (r: RunResult) => void;
  const done = new Promise<RunResult>(res => { settled = res; });
  let finishing = false;

  const finish = async (stopped: NonNullable<RunResult["stopped_because"]>) => {
    if (finishing) return;
    finishing = true;
    if (stopped !== "completed") await client.abort().catch(() => {});
    try {
      const s = await client.getSessionStats();
      result.cost_usd = s.cost;
      result.tool_calls = s.toolCalls;
      result.session_file = s.sessionFile ?? null;
      result.last_reply = await client.getLastAssistantText();
    } catch { /* the child may already be gone; keep what we have */ }
    await client.stop().catch(() => {});
    await unlockPaths(task.workdir, task.readonly);
    result.files_changed = await gitChangedSince(task.workdir, before);
    result.seconds = Math.round((Date.now() - state.startedAt) / 1000);
    result.turns = state.turns;
    result.stopped_because = stopped;
    result.state =
      stopped === "completed" ? "completed"
      : stopped === "aborted" ? "aborted"
      : stopped === "error" ? "error"
      : stopped === "asking" ? "asking"
      : "capped";
    writeResult(runDir, result);
    appendProgress(runDir, `END ${stopped} — $${result.cost_usd.toFixed(4)}, ${result.turns} turns`);
    settled(result);
  };

  client.onSessionEvent(async (event: any) => {
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);

    const ev = event.assistantMessageEvent;
    if (ev?.type === "tool_start") {
      appendProgress(runDir, `${ev.name} ${String(JSON.stringify(ev.input ?? "")).slice(0, 70)}`);
    }

    if (event.type !== "agent_end") return;
    if (!countTurn(state, event)) return;    // isTerminal:false is not a turn

    try {
      const s = await client.getSessionStats();
      state.costUsd = s.cost;
      result.cost_usd = s.cost;
      result.tool_calls = s.toolCalls;
    } catch { /* keep the last known numbers */ }
    result.turns = state.turns;
    writeResult(runDir, result);
    appendProgress(runDir, `turn ${state.turns} — $${state.costUsd.toFixed(4)}`);

    const b = breach(state, caps);
    await finish(b ?? "completed");
  });

  const wallClock = setTimeout(() => void finish("max_seconds"), task.maxSeconds * 1000);

  try {
    await client.start();
    const st = await client.getState();
    result.model = st.model ?? null;
    result.session_file = st.sessionFile ?? null;
    writeResult(runDir, result);
    appendProgress(runDir, `START ${task.model}`);
    await client.prompt(task.body);
  } catch (e) {
    appendProgress(runDir, `ERROR ${String(e)}`);
    await finish("error");
  }

  const r = await done;
  clearTimeout(wallClock);
  return r;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/broker.test.ts`
Expected: PASS, 6 tests

`onSessionEvent(listener) => unsubscribe` is verified at `rpc-client.ts:529`.
`onEvent` at `:516` is the narrower agent-only stream; use `onSessionEvent`.

- [ ] **Step 5: Commit**

```bash
git add src/broker.ts test/broker.test.ts
git commit -m "feat(broker): RPC-backed run with cap enforcement and guaranteed unlock"
```

---

### Task 6: The socket — say, steer, state, stop

**Files:**
- Modify: `src/broker.ts` (add the socket server)
- Create: `src/client.ts`
- Test: `test/socket.test.ts`

**Interfaces:**
- Produces:
```ts
// src/client.ts
export type Op =
  | { op: "say"; text: string }
  | { op: "steer"; text: string }
  | { op: "answer"; ask_id: string; text: string }
  | { op: "state" }
  | { op: "stop" };
export async function send(sockPath: string, msg: Op, timeoutMs?: number): Promise<any>;
export function sockPathFor(runDir: string): string;
```

- [ ] **Step 1: Write the failing tests**

Create `test/socket.test.ts`:

```ts
import { test, expect } from "bun:test";
import { send, sockPathFor } from "../src/client.ts";

test("send rejects when no broker is listening", async () => {
  await expect(send("/tmp/definitely-not-a-socket", { op: "state" }, 500)).rejects.toThrow();
});

test("say returns the agent's reply and the running totals", async () => {
  const { startBrokerForTest } = await import("./helpers.ts");
  const h = await startBrokerForTest({ turnCostUsd: 0.01, replies: ["first", "second"] });
  const r = await send(sockPathFor(h.runDir), { op: "say", text: "and now?" });
  expect(r.ok).toBe(true);
  expect(typeof r.reply).toBe("string");
  expect(r.turns).toBeGreaterThanOrEqual(1);
  await h.shutdown();
}, 30_000);

test("state returns the current result body", async () => {
  const { startBrokerForTest } = await import("./helpers.ts");
  const h = await startBrokerForTest({});
  const r = await send(sockPathFor(h.runDir), { op: "state" });
  expect(r.run_id).toBe(h.runId);
  await h.shutdown();
}, 30_000);

test("stop ends the run and marks it aborted", async () => {
  const { startBrokerForTest } = await import("./helpers.ts");
  const h = await startBrokerForTest({});
  await send(sockPathFor(h.runDir), { op: "stop" });
  const final = await h.settled;
  expect(final.stopped_because).toBe("aborted");
  await h.shutdown();
}, 30_000);
```

- [ ] **Step 2: Write `test/helpers.ts`**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBroker } from "../src/broker.ts";
import { newRunId, createRunDir, type RunResult } from "../src/rundir.ts";
import type { TaskSpec } from "../src/taskfile.ts";
import { send, sockPathFor } from "../src/client.ts";

export async function startBrokerForTest(script: object, over: Partial<TaskSpec> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "omp-sock-"));
  const runId = newRunId();
  const runDir = createRunDir(workdir, runId);
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ keepAlive: true, ...script });
  const task: TaskSpec = {
    model: "fake/fake-1", workdir, readonly: [], tools: "read",
    maxTurns: 120, maxUsd: 1.0, maxSeconds: 300, body: "do it", ...over,
  };
  const settled = runBroker({
    task, runDir, runId, command: ["bun", `${import.meta.dir}/fake-omp.ts`],
  });
  // wait for the socket to appear
  for (let i = 0; i < 200; i++) {
    try { await send(sockPathFor(runDir), { op: "state" }, 200); break; }
    catch { await Bun.sleep(50); }
  }
  return {
    workdir, runId, runDir, settled,
    shutdown: async () => {
      try { await send(sockPathFor(runDir), { op: "stop" }, 500); } catch {}
      await settled.catch(() => {});
    },
  };
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/socket.test.ts`
Expected: FAIL — cannot resolve `../src/client.ts`

- [ ] **Step 4: Implement `src/client.ts`**

```ts
import { join } from "node:path";
import { connect } from "node:net";

export type Op =
  | { op: "say"; text: string }
  | { op: "steer"; text: string }
  | { op: "answer"; ask_id: string; text: string }
  | { op: "state" }
  | { op: "stop" };

export const sockPathFor = (runDir: string) => join(runDir, "sock");

export function send(sockPath: string, msg: Op, timeoutMs = 3_600_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("socket timeout")); }, timeoutMs);
    const done = (fn: () => void) => { clearTimeout(timer); sock.end(); fn(); };
    sock.on("error", err => done(() => reject(err)));
    sock.on("connect", () => sock.write(`${JSON.stringify(msg)}\n`));
    sock.on("data", chunk => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try { const r = JSON.parse(buf.slice(0, nl)); done(() => resolve(r)); }
      catch (e) { done(() => reject(e)); }
    });
    sock.on("close", () => { if (!buf.includes("\n")) done(() => reject(new Error("broker closed the socket"))); });
  });
}
```

- [ ] **Step 5: Add the server to `src/broker.ts`**

Insert before `await client.start()`, and make `finish` also close the server.

```ts
import { createServer } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { sockPathFor } from "./client.ts";

// ... inside runBroker, after `const done = new Promise...`:

/** Resolves when the current turn settles, so `say` can return the reply. */
let turnWaiters: Array<() => void> = [];
const waitForTurn = () => new Promise<void>(res => turnWaiters.push(res));
// call `turnWaiters.splice(0).forEach(f => f())` inside the agent_end handler,
// after stats are refreshed and before the breach check.

const sockPath = sockPathFor(runDir);
if (existsSync(sockPath)) unlinkSync(sockPath);
const server = createServer(conn => {
  let buf = "";
  conn.on("data", async chunk => {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let reply: unknown;
    try {
      const msg = JSON.parse(line);
      switch (msg.op) {
        case "state": reply = result; break;
        case "say": {
          const settle = waitForTurn();
          await client.followUp(msg.text);
          await settle;
          reply = { ok: true, reply: result.last_reply, turns: result.turns, cost_usd: result.cost_usd };
          break;
        }
        case "steer": await client.steer(msg.text); reply = { ok: true }; break;
        case "stop": reply = { ok: true }; void finish("aborted"); break;
        default: reply = { ok: false, error: `unknown op: ${msg.op}` };
      }
    } catch (e) { reply = { ok: false, error: String(e) }; }
    conn.write(`${JSON.stringify(reply)}\n`);
  });
});
server.listen(sockPath);
// in finish(): server.close(); if (existsSync(sockPath)) unlinkSync(sockPath);
```

Also change the `agent_end` handler so it only calls `finish("completed")` when
no follow-up is pending — a `say` must not end the run.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/socket.test.ts test/broker.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/client.ts src/broker.ts test/socket.test.ts test/helpers.ts
git commit -m "feat(socket): say, steer, state and stop over a unix socket"
```

---

### Task 7: The `dispatch` CLI

**Files:**
- Create: `bin/dispatch`
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `export async function main(argv: string[]): Promise<number>;`

Subcommands: `run <task.md> [--bg] [--dry-run]`, `say <id> "msg"`, `steer <id> "msg"`, `answer <id> "text"`, `list`, `tail <id> [-n N]`, `stop <id>`, `result <id>`.

`--dry-run` runs preflight, prints the resolved omp argv and the lock plan, and spawns nothing. It is the cheapest way to check a task file.

- [ ] **Step 1: Write the failing tests**

Create `test/cli.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = `${import.meta.dir}/../bin/dispatch`;
const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawn(["bun", BIN, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });

async function out(p: ReturnType<typeof run>) {
  return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
}

test("no arguments prints usage and exits non-zero", async () => {
  const r = await out(run([]));
  expect(r.code).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("dispatch run");
});

test("dry-run prints the resolved argv and spawns nothing", async () => {
  const wd = mkdtempSync(join(tmpdir(), "omp-cli-"));
  const task = join(wd, "t.md");
  writeFileSync(task, `---\nmodel: fake-1\nworkdir: ${wd}\ntools: read,bash\n---\ndo it\n`);
  const r = await out(run(["run", task, "--dry-run"]));
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("--tools=read,bash");
  expect(r.stdout).toContain("--no-extensions");
});

test("dry-run fails a task file with no model", async () => {
  const wd = mkdtempSync(join(tmpdir(), "omp-cli-"));
  const task = join(wd, "t.md");
  writeFileSync(task, `---\nworkdir: ${wd}\n---\ndo it\n`);
  const r = await out(run(["run", task, "--dry-run"]));
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("model");
});

test("list on a workdir with no runs prints nothing and exits 0", async () => {
  const wd = mkdtempSync(join(tmpdir(), "omp-cli-"));
  const r = await out(run(["list"], { OMP_DISPATCH_WORKDIR: wd }));
  expect(r.code).toBe(0);
});

test("result for an unknown run id exits non-zero", async () => {
  const wd = mkdtempSync(join(tmpdir(), "omp-cli-"));
  const r = await out(run(["result", "nope"], { OMP_DISPATCH_WORKDIR: wd }));
  expect(r.code).not.toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/cli.test.ts`
Expected: FAIL — `bin/dispatch` does not exist

- [ ] **Step 3: Create `bin/dispatch`**

```ts
#!/usr/bin/env bun
import { main } from "../src/cli.ts";
process.exit(await main(process.argv.slice(2)));
```

Then `chmod +x bin/dispatch`.

- [ ] **Step 4: Implement `src/cli.ts`**

Key points: `run` without `--bg` awaits `runBroker` in-process. `run --bg` re-execs itself detached with `OMP_DISPATCH_BROKER=1` and prints the run id immediately. The workdir for `list`/`tail`/etc. is `OMP_DISPATCH_WORKDIR` or `process.cwd()`.

```ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTaskFile } from "./taskfile.ts";
import { assertProviderHasModel, readModelCatalogue } from "./preflight.ts";
import {
  newRunId, createRunDir, runDirFor, listRuns, readResult, runsRoot,
} from "./rundir.ts";
import { runBroker } from "./broker.ts";
import { send, sockPathFor } from "./client.ts";

const ROLES = join(import.meta.dir, "..", "roles");
const USAGE = `
dispatch run    <task.md> [--bg] [--dry-run]
dispatch say    <run_id> "message"
dispatch steer  <run_id> "message"
dispatch answer <run_id> "text"
dispatch list
dispatch tail   <run_id> [-n N]
dispatch stop   <run_id>
dispatch result <run_id>
`.trim();

const workdirOf = () => process.env.OMP_DISPATCH_WORKDIR ?? process.cwd();

function findRun(runId: string): string {
  const dir = runDirFor(workdirOf(), runId);
  if (!existsSync(join(dir, "result.json"))) throw new Error(`unknown run: ${runId}`);
  return dir;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd) { console.log(USAGE); return 2; }

  try {
    switch (cmd) {
      case "run": {
        const taskPath = resolve(rest[0] ?? "");
        const task = parseTaskFile(readFileSync(taskPath, "utf8"), { taskPath, rolesDir: ROLES });
        assertProviderHasModel(task.model, await readModelCatalogue());

        const args = [
          `--tools=${task.tools}`, "--no-skills", "--no-rules",
          "--no-extensions", "--no-lsp", "--no-pty", `--max-time=${task.maxSeconds}`,
        ];
        if (rest.includes("--dry-run")) {
          console.log(`model    ${task.model}`);
          console.log(`workdir  ${task.workdir}`);
          console.log(`lock     ${task.readonly.join(" ") || "(nothing)"}`);
          console.log(`caps     ${task.maxTurns} turns, $${task.maxUsd}, ${task.maxSeconds}s`);
          console.log(`argv     omp --mode rpc ${args.join(" ")}`);
          return 0;
        }

        const runId = newRunId();
        const runDir = createRunDir(task.workdir, runId);

        if (rest.includes("--bg") && !process.env.OMP_DISPATCH_BROKER) {
          Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "dispatch"), "run", taskPath], {
            env: { ...process.env, OMP_DISPATCH_BROKER: "1", OMP_DISPATCH_RUN_ID: runId },
            stdio: ["ignore", "ignore", "ignore"],
          }).unref();
          console.log(runId);
          return 0;
        }

        const r = await runBroker({ task, runDir, runId });
        console.log(JSON.stringify(r, null, 2));
        return r.state === "completed" || r.state === "asking" ? 0 : 1;
      }

      case "say":
      case "steer": {
        const dir = findRun(rest[0] ?? "");
        const r = await send(sockPathFor(dir), { op: cmd, text: rest.slice(1).join(" ") } as any);
        console.log(JSON.stringify(r, null, 2));
        return r.ok === false ? 1 : 0;
      }

      case "answer": {
        const dir = findRun(rest[0] ?? "");
        const ask = readResult(dir).ask;
        if (!ask) throw new Error(`run ${rest[0]} is not waiting on a question`);
        const r = await send(sockPathFor(dir), { op: "answer", ask_id: ask.ask_id, text: rest.slice(1).join(" ") });
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }

      case "stop": {
        const dir = findRun(rest[0] ?? "");
        await send(sockPathFor(dir), { op: "stop" }, 10_000).catch(() => {});
        return 0;
      }

      case "result": {
        console.log(JSON.stringify(readResult(findRun(rest[0] ?? "")), null, 2));
        return 0;
      }

      case "tail": {
        const dir = findRun(rest[0] ?? "");
        const n = Number(rest[rest.indexOf("-n") + 1]) || 40;
        const log = join(dir, "progress.log");
        if (!existsSync(log)) return 0;
        console.log(readFileSync(log, "utf8").split("\n").filter(Boolean).slice(-n).join("\n"));
        return 0;
      }

      case "list": {
        for (const r of listRuns(workdirOf())) {
          const state = r.alive ? "alive" : r.result.state;
          console.log(
            `${r.runId}  ${state.padEnd(10)} ${String(r.result.turns).padStart(4)} turns  ` +
            `$${r.result.cost_usd.toFixed(4)}  ${r.result.stopped_because ?? ""}`,
          );
        }
        return 0;
      }

      default:
        console.log(USAGE);
        return 2;
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 1;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/cli.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
chmod +x bin/dispatch
git add bin/dispatch src/cli.ts test/cli.test.ts
git commit -m "feat(cli): dispatch run/say/steer/answer/list/tail/stop/result"
```

---

### Task 8: Resume fallback when the broker is dead

**Files:**
- Create: `src/resume.ts`
- Modify: `src/cli.ts` (the `say` branch)
- Test: `test/resume.test.ts`

**Interfaces:**
- Produces:
```ts
export async function sayViaResume(
  sessionFile: string, workdir: string, model: string, text: string,
  spawn?: (argv: string[]) => { exited: Promise<number>; stdout: ReadableStream<Uint8Array> },
): Promise<{ ok: true; reply: string; via: "resume" }>;
```

This is what makes choosing a daemon safe. The RPC path is live and cheap; the session file is the durable record. If the broker is gone, `say` transparently runs `omp -r <session> -p "<text>"` and the conversation continues. The reply carries `via: "resume"` so Claude can see which path served it.

- [ ] **Step 1: Write the failing tests**

Create `test/resume.test.ts`:

```ts
import { test, expect } from "bun:test";
import { sayViaResume } from "../src/resume.ts";

function fakeSpawn(stdout: string, code = 0) {
  return () => ({
    exited: Promise.resolve(code),
    stdout: new Response(stdout).body!,
  });
}

test("returns the resumed reply", async () => {
  const r = await sayViaResume("/tmp/s.jsonl", "/tmp", "fake/fake-1", "carry on", fakeSpawn("picked up where we left off"));
  expect(r.reply).toContain("picked up");
  expect(r.via).toBe("resume");
});

test("throws when the resume command fails", async () => {
  await expect(
    sayViaResume("/tmp/s.jsonl", "/tmp", "fake/fake-1", "hi", fakeSpawn("", 1)),
  ).rejects.toThrow(/resume/);
});

test("throws when there is no session file to resume", async () => {
  await expect(sayViaResume("", "/tmp", "m", "hi", fakeSpawn(""))).rejects.toThrow(/session/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/resume.test.ts`
Expected: FAIL — cannot resolve `../src/resume.ts`

- [ ] **Step 3: Implement `src/resume.ts`**

```ts
export async function sayViaResume(
  sessionFile: string,
  workdir: string,
  model: string,
  text: string,
  spawn?: (argv: string[]) => { exited: Promise<number>; stdout: ReadableStream<Uint8Array> },
): Promise<{ ok: true; reply: string; via: "resume" }> {
  if (!sessionFile) {
    throw new Error("cannot resume: this run recorded no session file");
  }
  const argv = [
    "omp", "-r", sessionFile, "-p", text,
    "--model", model, "--no-skills", "--no-rules", "--no-extensions",
  ];
  const proc = spawn
    ? spawn(argv)
    : Bun.spawn(argv, { cwd: workdir, stdout: "pipe", stderr: "ignore" });
  const reply = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) throw new Error(`resume failed: omp exited non-zero`);
  return { ok: true, reply: reply.trim(), via: "resume" };
}
```

- [ ] **Step 4: Wire it into the `say` branch of `src/cli.ts`**

Replace the `say` case body with:

```ts
case "say": {
  const dir = findRun(rest[0] ?? "");
  const text = rest.slice(1).join(" ");
  try {
    const r = await send(sockPathFor(dir), { op: "say", text });
    console.log(JSON.stringify(r, null, 2));
    return r.ok === false ? 1 : 0;
  } catch {
    // The broker is gone. The session file is the durable record.
    const prev = readResult(dir);
    const { sayViaResume } = await import("./resume.ts");
    const r = await sayViaResume(prev.session_file ?? "", workdirOf(), prev.model ? `${prev.model.provider}/${prev.model.id}` : "", text);
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
}
```

Keep `steer` on the socket only — you cannot interrupt a turn that is not running.

- [ ] **Step 5: Add the fallback test**

Append to `test/resume.test.ts`:

```ts
test("cli say falls back to resume when the socket is gone", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createRunDir, newRunId, writeResult, emptyResult } = await import("../src/rundir.ts");

  const wd = mkdtempSync(join(tmpdir(), "omp-resume-"));
  const id = newRunId();
  const dir = createRunDir(wd, id);
  writeResult(dir, { ...emptyResult(id), state: "completed", session_file: "/tmp/s.jsonl" });
  // no socket exists, so `say` must take the resume path and report the failure
  // to reach omp rather than the failure to reach the socket
  const p = Bun.spawn(["bun", `${import.meta.dir}/../bin/dispatch`, "say", id, "hi"], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMP_DISPATCH_WORKDIR: wd, PATH: "/nonexistent" },
  });
  const err = await new Response(p.stderr).text();
  await p.exited;
  expect(err).not.toContain("socket");
});
```

- [ ] **Step 6: Run tests**

Run: `bun test`
Expected: PASS, all suites

- [ ] **Step 7: Commit**

```bash
git add src/resume.ts src/cli.ts test/resume.test.ts
git commit -m "feat(resume): fall back to omp -r when the broker is gone"
```

---

### Task 9: `ask_supervisor` — the agent asks Claude

**Files:**
- Create: `src/asktool.ts`
- Modify: `src/broker.ts` (register the tool, handle `answer`)
- Test: `test/ask.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AskHandle {
  tool: unknown;                                  // RpcClientCustomTool
  answer(askId: string, text: string): boolean;   // false when no such pending ask
  pending(): { ask_id: string; question: string; context?: string } | null;
}
export function createAskSupervisor(
  onAsk: (ask: { ask_id: string; question: string; context?: string }) => void,
): AskHandle;
```

**The mechanism:** `RpcClientCustomTool.execute` returns a promise. The broker simply does not resolve it until `dispatch answer` arrives. omp's turn parks on the tool call. No manual frame handling.

- [ ] **Step 1: Write the failing tests**

Create `test/ask.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createAskSupervisor } from "../src/asktool.ts";

test("the tool exposes the expected name and schema", () => {
  const h = createAskSupervisor(() => {});
  const t = h.tool as any;
  expect(t.name).toBe("ask_supervisor");
  expect(t.parameters.properties.question).toBeDefined();
  expect(t.parameters.required).toContain("question");
});

test("execute parks until answered, then returns the answer", async () => {
  let seen: any = null;
  const h = createAskSupervisor(a => { seen = a; });
  const t = h.tool as any;
  const pending = t.execute({ question: "which page wins?" }, { toolCallId: "x", signal: new AbortController().signal, sendUpdate() {} });

  await Bun.sleep(10);
  expect(seen.question).toBe("which page wins?");
  expect(h.pending()!.ask_id).toBe(seen.ask_id);

  expect(h.answer(seen.ask_id, "the older one")).toBe(true);
  expect(await pending).toContain("the older one");
  expect(h.pending()).toBeNull();
});

test("answering an unknown ask id returns false", () => {
  const h = createAskSupervisor(() => {});
  expect(h.answer("nope", "x")).toBe(false);
});

test("an aborted tool call rejects rather than hanging", async () => {
  const h = createAskSupervisor(() => {});
  const ac = new AbortController();
  const t = h.tool as any;
  const pending = t.execute({ question: "q" }, { toolCallId: "x", signal: ac.signal, sendUpdate() {} });
  ac.abort();
  await expect(pending).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/ask.test.ts`
Expected: FAIL — cannot resolve `../src/asktool.ts`

- [ ] **Step 3: Implement `src/asktool.ts`**

```ts
export interface Ask { ask_id: string; question: string; context?: string }
export interface AskHandle {
  tool: unknown;
  answer(askId: string, text: string): boolean;
  pending(): Ask | null;
}

export function createAskSupervisor(onAsk: (ask: Ask) => void): AskHandle {
  const waiting = new Map<string, { resolve: (s: string) => void; ask: Ask }>();
  let seq = 0;

  const tool = {
    name: "ask_supervisor",
    label: "Ask supervisor",
    description:
      "Ask the supervising Claude session a question and wait for its answer. " +
      "Use when you are blocked, or facing a judgement call the task file did not settle. " +
      "Do not use it for questions you can answer by reading the repository.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question. Be specific." },
        context: { type: "string", description: "What you have already tried or found." },
      },
      required: ["question"],
    },
    execute(
      params: { question: string; context?: string },
      ctx: { signal: AbortSignal },
    ): Promise<string> {
      const ask: Ask = {
        ask_id: `ask_${++seq}`, question: params.question, context: params.context,
      };
      return new Promise<string>((resolve, reject) => {
        waiting.set(ask.ask_id, { resolve, ask });
        ctx.signal.addEventListener("abort", () => {
          waiting.delete(ask.ask_id);
          reject(new Error("ask_supervisor was aborted"));
        }, { once: true });
        onAsk(ask);
      });
    },
  };

  return {
    tool,
    answer(askId, text) {
      const w = waiting.get(askId);
      if (!w) return false;
      waiting.delete(askId);
      w.resolve(text);
      return true;
    },
    pending() {
      const first = waiting.values().next();
      return first.done ? null : first.value.ask;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/ask.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire into `src/broker.ts`**

- Build the handle before the client:

```ts
const asker = createAskSupervisor(ask => {
  result.ask = ask;
  result.state = "asking";
  result.stopped_because = "asking";
  writeResult(runDir, result);
  appendProgress(runDir, `ASK ${ask.question}`);
});
```

- Pass `customTools: [asker.tool as any]` in the `RpcClient` options.
- Add the socket op:

```ts
case "answer": {
  const ok = asker.answer(msg.ask_id, msg.text);
  if (ok) {
    result.ask = null;
    result.state = "running";
    result.stopped_because = null;
    writeResult(runDir, result);
  }
  reply = { ok };
  break;
}
```

- An unanswered ask still counts against `max_seconds`, so the existing wall-clock timer is the only timeout it needs. Do not add a second one.

- [ ] **Step 6: Add the end-to-end ask test**

Append to `test/ask.test.ts`:

```ts
test("end to end: the agent parks a question and dispatch answers it", async () => {
  const { startBrokerForTest } = await import("./helpers.ts");
  const { send, sockPathFor } = await import("../src/client.ts");
  const { readResult } = await import("../src/rundir.ts");

  const h = await startBrokerForTest({ askOnTurn: 1, turnCostUsd: 0.01 });
  for (let i = 0; i < 100 && !readResult(h.runDir).ask; i++) await Bun.sleep(50);

  const parked = readResult(h.runDir);
  expect(parked.state).toBe("asking");
  expect(parked.ask!.question).toContain("disagree");

  await send(sockPathFor(h.runDir), { op: "answer", ask_id: parked.ask!.ask_id, text: "the older page wins" });
  const final = await h.settled;
  expect(final.ask).toBeNull();
  expect(final.state).toBe("completed");
}, 30_000);
```

- [ ] **Step 7: Run the whole suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/asktool.ts src/broker.ts test/ask.test.ts
git commit -m "feat(ask): ask_supervisor host tool lets a dispatched agent ask Claude"
```

---

### Task 10: Plugin packaging, the skill, and the README

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Create: `skills/dispatch-to-omp/SKILL.md`
- Create: `skills/dispatch-to-omp/references/cost-model.md`
- Create: `skills/dispatch-to-omp/references/gotchas.md`
- Create: `skills/dispatch-to-omp/references/parity.md`
- Create: `README.md`
- Test: `test/packaging.test.ts`

**Interfaces:** none — this task ships documentation and manifests.

- [ ] **Step 1: Write the failing tests**

Create `test/packaging.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the plugin manifest is valid json with a name and version", () => {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(m.name).toBe("omp-dispatch");
  expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the marketplace manifest points at this plugin", () => {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  expect(m.plugins.some((p: any) => p.name === "omp-dispatch")).toBe(true);
});

test("the skill has front matter with name and description", () => {
  const s = readFileSync(join(root, "skills/dispatch-to-omp/SKILL.md"), "utf8");
  expect(s.startsWith("---")).toBe(true);
  expect(s).toMatch(/^name:\s*dispatch-to-omp$/m);
  expect(s).toMatch(/^description:\s*\S/m);
});

test("the skill says when NOT to use omp", () => {
  const s = readFileSync(join(root, "skills/dispatch-to-omp/SKILL.md"), "utf8");
  expect(s.toLowerCase()).toContain("native");
});

test("every reference the skill links to exists", () => {
  const dir = join(root, "skills/dispatch-to-omp/references");
  for (const f of ["cost-model.md", "gotchas.md", "parity.md"]) {
    expect(existsSync(join(dir, f))).toBe(true);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/packaging.test.ts`
Expected: FAIL — manifests do not exist

- [ ] **Step 3: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "omp-dispatch",
  "version": "0.1.0",
  "description": "Dispatch bulk work to long-lived omp subagents over RPC, with two-way conversation, hard budget caps and OS-level path locking.",
  "author": { "name": "Jamie Steiner" }
}
```

- [ ] **Step 4: Create `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "omp-dispatch",
  "description": "Claude supervises, omp executes.",
  "owner": { "name": "Jamie Steiner" },
  "plugins": [
    {
      "name": "omp-dispatch",
      "description": "Dispatch bulk work to omp subagents at a fifth of the token floor, and hold a real conversation with them.",
      "version": "0.1.0",
      "source": "./",
      "category": "development"
    }
  ]
}
```

- [ ] **Step 5: Write `skills/dispatch-to-omp/SKILL.md`**

```markdown
---
name: dispatch-to-omp
description: Use when a task needs bulk reading or writing across many files and does not need Claude's own MCP servers or skills - dispatches the work to a cheap omp subagent, with two-way conversation, budget caps and path locking. Also use when a run should outlive this Claude session.
---

# Dispatching work to omp

Claude plans and verifies. `omp` does the bulk token work at a fifth of the
startup floor. A shell-side script does every mechanical step, before any model
exists.

## Decide first: omp or a native subagent?

**Use a native Claude subagent when:**
- the task needs Claude's MCP servers, skills, or permission setup
- the task is short — the setup floor dominates and file plumbing costs more than it saves
- the work needs Claude's judgement all the way through

**Use omp-dispatch when:**
- the task is bulk reading or writing across many files
- several similar items can be batched into one run
- the work is mechanical once the plan exists
- the run should outlive this Claude session

If you are unsure, it is a native subagent. Read `references/parity.md` for the
full comparison.

## Batch. It is the dominant cost lever.

Measured: one document alone costs $0.272. Four documents in one run cost
**$0.080 each**. Setup context is paid once per run, so a run that handles four
items amortises it four ways. Never dispatch items one at a time when they
could go together. See `references/cost-model.md`.

## How to dispatch

1. **Do every mechanical step yourself first** — copying, hashing, converting,
   dating, resolving names. None of it needs a model, and having the agent shell
   out for it costs a round trip each time. Doing it first also lets the paths
   be locked before the agent exists.

2. **Write a task file.** Front matter, then the prompt.

   ```yaml
   ---
   model: deepseek/deepseek-v4-flash
   workdir: /Users/jamie/wiki
   readonly: [raw, schema, CLAUDE.md]
   tools: read,write,edit,bash
   max_turns: 120
   max_usd: 1.00
   max_seconds: 3300
   ---

   Ingest everything in inbox/ following CLAUDE.md exactly.
   All four documents in one pass.
   ```

3. **Check it without spending anything:** `dispatch run task.md --dry-run`

4. **Run it.** Foreground for short work; `--bg` with
   `Bash(run_in_background: true)` for long work, so the harness pings you when
   it exits.

   ```bash
   dispatch run task.md
   ```

5. **Read `result.json`, not the stream.** It is about a kilobyte and it carries
   `files_changed` computed from git, `cost_usd`, `turns`, and the agent's last
   reply. Only open actual files for spot checks.

## Talking to a running agent

```bash
dispatch tail   <run_id>            # what is it doing
dispatch say    <run_id> "message"  # queue a message for after this turn
dispatch steer  <run_id> "message"  # interrupt the current turn now
dispatch stop   <run_id>            # abort and unlock
dispatch list                       # every run, alive or not
```

`steer` can abort the remaining tool calls in a turn. Use it when the agent is
visibly going the wrong way. Use `say` when it is not.

## When the agent asks you something

An agent that is blocked calls `ask_supervisor` and parks. `result.json` then
has `state: "asking"` and an `ask` block. Answer it:

```bash
dispatch answer <run_id> "the older page wins"
```

An unanswered question still burns the clock cap, so answer or stop.

## Verifying

Trust `files_changed` from `result.json` — it comes from git, never from the
agent. Read the diff, not the agent's summary of the diff.

## Gotchas

`references/gotchas.md` has the measured ones: what actually shrinks the tool
surface, why locking is `chmod` and not a permission file, and the provider
guard that stops a batch silently routing through the wrong provider.
```

- [ ] **Step 6: Write the three reference files**

`references/cost-model.md` — the measured table from spec §2, plus the batching
rule and the reference run's 133 turns / $0.16.

`references/gotchas.md` — spec §10's Claude Code permission list, the provider
guard, the §15 correction about `--tools=` versus `CLAUDE_CONFIG_DIR`, and the
`manage_skill` / `learn` leak.

`references/parity.md` — spec §4's table and spec §13's decision rule.

Copy the content from the spec verbatim; do not paraphrase it.

- [ ] **Step 7: Write `README.md`**

Cover: what it is, the one-paragraph why, install (`claude plugin install`),
the task-file format, the command list, and a link to the spec.

- [ ] **Step 8: Run the whole suite**

Run: `bun test`
Expected: PASS, every suite

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin skills README.md test/packaging.test.ts
git commit -m "feat(plugin): manifests, dispatch-to-omp skill and references"
```

---

### Task 11: The paid smoke test

**Files:**
- Create: `test/smoke.md` (a task file)
- Create: `scripts/smoke.sh`

**Interfaces:** none.

This is the only step that spends money. It runs against a flash model in a
throwaway directory and should cost well under a cent.

- [ ] **Step 1: Create `test/smoke.md`**

```markdown
---
model: deepseek/deepseek-v4-flash
workdir: /tmp/omp-dispatch-smoke
readonly: [locked]
tools: read,write
max_turns: 4
max_usd: 0.10
max_seconds: 120
---

Create a file called `hello.md` containing exactly one line: `it works`.
Then stop. Do not read or write anything else.
```

- [ ] **Step 2: Create `scripts/smoke.sh`**

```bash
#!/usr/bin/env bash
# The one test that spends money. Throwaway directory, flash model, tiny caps.
set -euo pipefail
WD=/tmp/omp-dispatch-smoke
rm -rf "$WD"; mkdir -p "$WD/locked"
echo "do not touch" > "$WD/locked/keep.txt"
git -C "$WD" init -q && git -C "$WD" add -A
git -C "$WD" -c user.email=t@t -c user.name=t commit -qm init

bun bin/dispatch run test/smoke.md

test -f "$WD/hello.md" || { echo "FAIL: hello.md was not created"; exit 1; }
grep -q "it works" "$WD/hello.md" || { echo "FAIL: wrong content"; exit 1; }
test -w "$WD/locked/keep.txt" || { echo "FAIL: locked path was not restored"; exit 1; }
echo "SMOKE OK"
```

- [ ] **Step 3: Run it**

```bash
chmod +x scripts/smoke.sh && ./scripts/smoke.sh
```

Expected: `SMOKE OK`, and the printed `result.json` shows `state: "completed"`,
`files_changed` containing `hello.md`, and a `cost_usd` under $0.01.

- [ ] **Step 4: Try the conversation against a real agent**

```bash
RUN=$(bun bin/dispatch run test/smoke.md --bg)
bun bin/dispatch tail "$RUN"
bun bin/dispatch say "$RUN" "Now add a second line saying: and it talks back"
bun bin/dispatch result "$RUN"
```

Expected: the second line appears in `hello.md` and `turns` is greater than 1.

- [ ] **Step 5: Commit**

```bash
git add test/smoke.md scripts/smoke.sh
git commit -m "test: paid smoke test for a real dispatch and a real follow-up"
```

---

## Self-review notes

**Spec coverage.** §5 architecture → Tasks 1-7. §6 task file → Task 1. §7 run
dir and `result.json` → Task 3. §8 commands → Tasks 6-7. §9 caps → Tasks 4-5.
§10 preflight and locking → Tasks 2, 5, 7. §11 progress → Tasks 3, 5. §12
`ask_supervisor` → Task 9. §13 when not to use → Task 10 (the skill). §14
resilience → Tasks 3 (liveness, stale-lock repair) and 8 (resume fallback). §16
testing → Task 4 (fake omp), Task 7 (`--dry-run`), Task 11 (smoke).

**Known gap, deliberate:** spec §3 defers worktree isolation. No task implements
it, as intended.

**Type consistency.** `RunResult`, `TaskSpec`, `CapState`, `Caps`, `Ask` and
`Op` are defined once and used with the same field names throughout.
`stopped_because` values match `StoppedBecause` in every task.

**No open guesses.** Every omp API this plan calls was read from
`@oh-my-pi/pi-coding-agent` on disk: `onSessionEvent` (`rpc-client.ts:529`),
`getSessionStats` (`:806`), `getLastAssistantText` (`:856`), `steer` (`:600`),
`followUp` (`:607`), `abort` (`:614`), `setCustomTools` (`:972`), and
`SessionStats.cost` (`agent-session-types.ts:426`).
