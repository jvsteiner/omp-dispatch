import { test, expect } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, chmodSync,
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
// real omp answer abort with their own unsolicited agent_end. The event
// listener is deliberately still attached when that frame arrives (it's only
// unsubscribed in finish()'s finally block, once teardown is complete) so
// that frame IS delivered to the handler — the `if (finishing) return` guard
// right after the frame is logged is what stops it from being re-counted as
// a turn. Fix round 2 found that an earlier version of this test passed even
// with that guard deleted, because unsubscribing immediately (rather than at
// the end) closed the hole by a different route, making the guard
// unreachable and this test vacuous. Verified for real this time: removing
// the `if (finishing) return` guard at the top of the onSessionEvent handler
// in src/broker.ts makes this test fail with `turns: 2`, every time; putting
// it back makes it pass again. See the fix report for the exact commands run.
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
// yet) for 1000ms — long enough for a 50ms-interval poll to observe the
// breach on its own, independent of the per-turn check.
//
// Fix round 2 found the first version of this test vacuous: with the poll
// body disabled, the per-turn check (which only fires once turnDelayMs
// elapses, at 1000ms) reaches the same capped/max_usd verdict, just later —
// so state/stopped_because alone can't tell which path caught it. This
// version asserts two things only the poll can produce: the run finishes
// well under turnDelayMs, and progress.log has the poll's own log line.
// Verified: commenting out the poll's setInterval body makes this test fail
// (both the elapsed-time assertion and the log-line assertion) while the
// other 13 tests still pass; restoring it passes again. See the fix report.
test("a periodic poll catches a budget breach mid-turn, before any agent_end", async () => {
  process.env.OMP_DISPATCH_POLL_MS = "50";
  try {
    const s = setup({ turnCostUsd: 5.0, turnDelayMs: 1000 }, { maxUsd: 1.0, maxSeconds: 300 });
    const t0 = Date.now();
    const r = await runBroker(s);
    const elapsedMs = Date.now() - t0;
    expect(r.state).toBe("capped");
    expect(r.stopped_because).toBe("max_usd");
    expect(elapsedMs).toBeLessThan(500);       // only reachable before the turn's own 1000ms delay elapses
    const log = readFileSync(join(s.runDir, "progress.log"), "utf8");
    expect(log).toContain("POLL breach detected mid-turn");
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

// --- Fix round 2 additions -------------------------------------------------

// NEW Critical: costPoll used to be assigned only after `await client.start()`.
// A signal (or the wall clock) firing while start() is still pending runs
// finish(), which calls clearInterval(costPoll) while it's still undefined —
// a no-op. start() then resolves (readyDelayMs makes that resolution land
// after finish() has already completed) and unconditionally creates a
// pollIntervalMs-period interval that nothing will ever clear again, since
// finish() already ran and won't run a second time.
//
// runBroker()'s own promise resolves fine either way — finish() settles
// `done` independent of whatever the leaked interval does afterward, so
// asserting on the returned RunResult alone is vacuous here (this is exactly
// how my first attempt at this test passed without actually exercising the
// bug). The real, reported symptom is a process that never exits on its own.
// That needs a real separate process to observe: this spawns one that runs
// the whole scenario and deliberately never calls process.exit(), then
// checks whether it exits by itself.
//
// Verified: with pollIntervalMs forced tiny (50ms, via OMP_DISPATCH_POLL_MS)
// and the `if (!finishing)` guard around the post-start() block reverted (so
// costPoll is always assigned), the spawned process printed
// RUNBROKER_RESOLVED but then hung past the 4s budget — killed, `hung: true`.
// With the guard restored, it exits on its own in well under a second.
test("a signal during client startup does not leave the process hanging on a leaked poll", async () => {
  const scriptDir = mkdtempSync(join(tmpdir(), "omp-repro-"));
  const scriptPath = join(scriptDir, "repro.ts");
  const brokerPath = new URL("../src/broker.ts", import.meta.url).pathname;
  const rundirPath = new URL("../src/rundir.ts", import.meta.url).pathname;
  const fakePath = join(import.meta.dir, "fake-omp.ts");
  writeFileSync(scriptPath, `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBroker } from ${JSON.stringify(brokerPath)};
import { newRunId, createRunDir } from ${JSON.stringify(rundirPath)};

const workdir = mkdtempSync(join(tmpdir(), "omp-broker-"));
const runId = newRunId();
const runDir = createRunDir(workdir, runId);
process.env.FAKE_OMP_SCRIPT = JSON.stringify({ readyDelayMs: 500 });
const task = {
  model: "fake/fake-1", workdir, readonly: [], tools: "read",
  maxTurns: 120, maxUsd: 1.0, maxSeconds: 300, body: "do it",
};
const before = new Set(process.listeners("SIGINT"));
const p = runBroker({ task, runDir, runId, command: ["bun", ${JSON.stringify(fakePath)}] });
let added = [];
while (added.length === 0) {
  added = process.listeners("SIGINT").filter(l => !before.has(l));
  await new Promise(r => setTimeout(r, 1));
}
added[0]("SIGINT");
await p;
console.log("RUNBROKER_RESOLVED");
// Deliberately no process.exit(): a leaked, uncleared setInterval is exactly
// what would keep this process running past this point on its own.
`);

  const proc = Bun.spawn(["bun", scriptPath], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMP_DISPATCH_POLL_MS: "50" },
  });
  const outcome = await Promise.race([
    proc.exited.then(code => ({ hung: false as const, code })),
    Bun.sleep(4000).then(() => ({ hung: true as const })),
  ]);
  if (outcome.hung) proc.kill();
  const stdout = await new Response(proc.stdout).text().catch(() => "");

  expect(stdout).toContain("RUNBROKER_RESOLVED");   // runBroker itself did settle
  expect(outcome.hung).toBe(false);                 // and the process must exit on its own
}, 10_000);

// NEW Important: rpc-client.ts calls the onSessionEvent listener bare, with
// nothing to catch a throw inside it. toolCallsPerTurn:0 plus turnDelayMs
// gives a clean gap between events.jsonl's creation (on agent_start) and its
// next write (on the delayed agent_end) to chmod it read-only in between,
// forcing a real EACCES the same way test/preflight.test.ts does for chmod.
//
// Verified: removing the handler's own try/catch makes the appendFileSync
// throw propagate uncaught through rpc-client.ts's #handleLine (bun test
// reports it as a synchronous EACCES thrown from inside the RPC client,
// not a graceful failure) instead of routing to finish() — meaning in a
// real (non-test) run, nothing would catch it, finish() would never run,
// and `raw` would stay locked with no result written. With the try/catch
// restored, this test passes cleanly in well under a second.
test("a handler exception (e.g. events.jsonl becoming unwritable) still reaches teardown", async () => {
  const s = setup({ toolCallsPerTurn: 0, turnDelayMs: 300 }, { readonly: ["raw"] });
  mkdirSync(join(s.task.workdir, "raw"));
  writeFileSync(join(s.task.workdir, "raw", "a.txt"), "a");

  const p = runBroker(s);
  await waitForProgress(s.runDir, "START");
  const eventsPath = join(s.runDir, "events.jsonl");
  const deadline = Date.now() + 5000;
  while (!existsSync(eventsPath)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for events.jsonl to be created");
    await new Promise(r => setTimeout(r, 5));
  }
  chmodSync(eventsPath, 0o444);
  const r = await p;

  expect(r.state).toBe("error");
  expect(statSync(join(s.task.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

// C1 (completed): the unlockPaths-throws branch IS testable, reproduced the
// same way test/preflight.test.ts:90-97 has done since Task 2 —
// chmodSync(sub, 0o000) on a subdirectory that already exists (so it's
// included in the run's own initial recursive lock) makes the later
// `chmod -R u+w raw` fail trying to recurse into it, with no root needed.
test("finish still settles as an error when unlockPaths itself fails (a real chmod failure, no root)", async () => {
  const s = setup({ turnDelayMs: 300 }, { readonly: ["raw"] });
  mkdirSync(join(s.task.workdir, "raw"));
  writeFileSync(join(s.task.workdir, "raw", "a.txt"), "a");
  const sub = join(s.task.workdir, "raw", "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "f.txt"), "x");

  const p = runBroker(s);
  await waitForProgress(s.runDir, "START");
  chmodSync(sub, 0o000);   // owner can still set this; no root needed
  const r = await p;

  expect(r.state).toBe("error");
  expect(r.stopped_because).toBe("error");
  const log = readFileSync(join(s.runDir, "progress.log"), "utf8");
  expect(log).toContain("failed to unlock paths");

  chmodSync(sub, 0o700);   // restore so the tmp dir can be cleaned up normally
}, 30_000);
