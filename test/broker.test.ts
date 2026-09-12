import { test, expect } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBroker } from "../src/broker.ts";
import { newRunId, createRunDir } from "../src/rundir.ts";
import type { TaskSpec } from "../src/taskfile.ts";

// Polls a run's progress.log for a substring instead of a fixed sleep, so
// tests that need the broker to have reached a certain point (paths locked,
// child started) aren't tuned to a guessed delay.
async function waitForProgress(runDir: string, substr: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(join(runDir, "progress.log")) && readFileSync(join(runDir, "progress.log"), "utf8").includes(substr)) {
      return;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for "${substr}" in progress.log`);
    await new Promise(r => setTimeout(r, 10));
  }
}

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

// --- Fix round 1 additions -------------------------------------------------

// I6: regression coverage for the turn-double-count bug found in the first
// pass. finish() calls client.abort() on a cap breach, and both the fake and
// real omp answer abort with their own unsolicited agent_end — that frame
// must not be re-counted as a turn. This is guarded two ways now (the
// listener is unsubscribed before abort() is even called, and the handler
// itself no-ops once a settle is under way); this test protects the
// observable invariant — the turn count — rather than pinning down which one
// of those provides it, so it still fails if a future cleanup removes both.
test("an abort's own echoed agent_end does not double-count a turn", async () => {
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0 });
  const r = await runBroker(s);
  expect(r.turns).toBe(1);
}, 30_000);

// I7a: the wall clock, not just the per-turn cap check, must be able to stop
// a run — a single turn that runs long (or hangs) never reaches the
// agent_end-driven breach check at all.
test("the wall clock stops a run whose single turn runs past max_seconds", async () => {
  const s = setup({ turnDelayMs: 2000 }, { maxSeconds: 1 });
  const r = await runBroker(s);
  expect(r.stopped_because).toBe("max_seconds");
  expect(r.state).toBe("capped");
}, 30_000);

// I7b: test 5 only covers unlock after a cap breach; the happy path needs
// its own coverage since finish()'s unlock call is unconditional but was
// never actually exercised on this branch.
test("locked paths are restored after a normal completion", async () => {
  const s = setup({}, { readonly: ["raw"] });
  mkdirSync(join(s.task.workdir, "raw"));
  writeFileSync(join(s.task.workdir, "raw", "a.txt"), "a");
  const r = await runBroker(s);
  expect(r.state).toBe("completed");
  expect(statSync(join(s.task.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

// I7c: nor is the error path (client.start() itself failing) covered —
// unlockPaths must still run when the run never gets far enough to prompt.
test("locked paths are restored after a start-up error", async () => {
  const s = setup({}, { readonly: ["raw"] });
  mkdirSync(join(s.task.workdir, "raw"));
  writeFileSync(join(s.task.workdir, "raw", "a.txt"), "a");
  const r = await runBroker({ ...s, command: ["bun", "/definitely/does/not/exist.ts"] });
  expect(r.state).toBe("error");
  expect(r.stopped_because).toBe("error");
  expect(statSync(join(s.task.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

// I8: a turn that never emits a terminal agent_end must still be capped.
// turnDelayMs keeps the fake mid-turn (cost already booked, no agent_end
// yet) long enough for a short-interval poll to observe the breach on its
// own, independent of the per-turn check.
test("a periodic poll catches a budget breach mid-turn, before any agent_end", async () => {
  process.env.OMP_DISPATCH_POLL_MS = "50";
  try {
    const s = setup({ turnCostUsd: 5.0, turnDelayMs: 1000 }, { maxUsd: 1.0, maxSeconds: 300 });
    const r = await runBroker(s);
    expect(r.state).toBe("capped");
    expect(r.stopped_because).toBe("max_usd");
  } finally {
    delete process.env.OMP_DISPATCH_POLL_MS;
  }
}, 30_000);

// I4: an omp child that dies mid-turn (crashes, OOMs) emits no agent_end and
// no further RPC responses. The run must end as an error within roughly one
// poll interval, not hang until the wall clock (up to 3300s by default).
test("an omp child that dies mid-turn ends the run as an error, not a hang", async () => {
  process.env.OMP_DISPATCH_POLL_MS = "50";
  try {
    const s = setup({ crashAfterPrompt: true }, { maxSeconds: 300 });
    const r = await runBroker(s);
    expect(r.state).toBe("error");
    expect(r.stopped_because).toBe("error");
  } finally {
    delete process.env.OMP_DISPATCH_POLL_MS;
  }
}, 30_000);

// C2: SIGINT/SIGTERM must run the same teardown as any other stop reason —
// abort the child and restore locked paths — instead of skipping it, which
// would leave the workspace unwritable on every Ctrl-C.
//
// This calls the registered listener directly rather than process.emit() or
// a real process.kill(): under bun test, process.emit("SIGINT") was found to
// invoke Bun's own default signal disposition (process termination) in
// addition to any registered listeners, which reliably killed the test
// runner itself (exit code 130) instead of exercising just our handler. See
// the fix report for the diagnosis. Calling the listener function directly
// is a plain function call with no signal semantics at all, so it can't
// trigger that.
test("SIGINT aborts the run, kills the child, and restores locked paths", async () => {
  // turnDelayMs keeps the run genuinely in flight — without it the fake's
  // single default turn can complete (and deregister the signal handler as
  // part of its own normal finish()) before this test gets a chance to send
  // the signal at all.
  const s = setup({ turnDelayMs: 2000 }, { readonly: ["raw"] });
  mkdirSync(join(s.task.workdir, "raw"));
  writeFileSync(join(s.task.workdir, "raw", "a.txt"), "a");

  const before = new Set(process.listeners("SIGINT"));
  const p = runBroker(s);
  await waitForProgress(s.runDir, "START");
  const added = process.listeners("SIGINT").filter(l => !before.has(l));
  expect(added.length).toBe(1);            // runBroker must register exactly its own handler
  (added[0] as (...a: unknown[]) => void)("SIGINT");
  const r = await p;

  expect(r.stopped_because).toBe("aborted");
  expect(r.state).toBe("aborted");
  expect(statSync(join(s.task.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

// C1: unlockPaths and gitChangedSince can both genuinely throw (a chmod
// failure, `git status` failing) — the tail of finish() must not let either
// throw skip settled(result) or leave the run stuck at state:"running".
// Exercised here via gitChangedSince: `before` is only non-null when the
// workdir is a real repo, so make it one, then delete .git mid-run so the
// final `git status --porcelain` genuinely fails.
test("finish still settles and writes a result even if git status fails", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-broker-"));
  await Bun.$`git init -q`.cwd(workdir).quiet();
  const runId = newRunId();
  const runDir = createRunDir(workdir, runId);
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 300 });
  const task: TaskSpec = {
    model: "fake/fake-1", workdir, readonly: [], tools: "read",
    maxTurns: 120, maxUsd: 1.0, maxSeconds: 300, body: "do it",
  };

  const p = runBroker({ task, runDir, runId, command: ["bun", `${import.meta.dir}/fake-omp.ts`] });
  await new Promise(r => setTimeout(r, 100));
  rmSync(join(workdir, ".git"), { recursive: true, force: true });
  const r = await p;

  expect(r.state).toBe("completed");
  expect(r.files_changed).toEqual([]);
}, 30_000);
