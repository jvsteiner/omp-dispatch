import { test, expect } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, type RunOptions } from "../src/runner.ts";
import { newRunId, createRunDir } from "../src/rundir.ts";

// Signal 0 sends nothing; it just probes whether the pid still exists.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Polls a run's progress.log for a substring instead of a fixed sleep, so
// tests that need the runner to have reached a certain point (paths locked,
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

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

function setup(script: object, over: Partial<RunOptions> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "omp-runner-"));
  const runId = newRunId();
  const runDir = createRunDir(workdir, runId);
  process.env.FAKE_OMP_SCRIPT = JSON.stringify(script);
  const opts: RunOptions = {
    prompt: "do it", model: "fake/fake-1", workdir, tools: "read",
    maxTurns: 120, maxUsd: 1.0, maxSeconds: 300,
    command: ["bun", `${import.meta.dir}/fake-omp.ts`],
    ...over,
  };
  return { opts, runDir, runId, workdir };
}

/**
 * The common shape: start, wait for the run to settle, then release the
 * handle. dispose() is in a finally because the MCP server — not the run —
 * owns the omp process now: a settled run leaves its agent alive until
 * someone disposes the handle, and a test that skipped it would leak one.
 */
async function runToSettled(s: ReturnType<typeof setup>) {
  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    return await handle.settled;
  } finally {
    await handle.dispose();
  }
}

test("a clean run completes and records cost and tool calls", async () => {
  const s = setup({ turnCostUsd: 0.02, toolCallsPerTurn: 3, replies: ["all done"] });
  const r = await runToSettled(s);
  expect(r.state).toBe("completed");
  expect(r.stopped_because).toBe("completed");
  expect(r.turns).toBe(1);
  expect(r.tool_calls).toBe(3);
  expect(r.cost_usd).toBeCloseTo(0.02, 5);
  expect(r.last_reply).toBe("all done");
}, 30_000);

test("a non-terminal agent_end does not count as a turn", async () => {
  const s = setup({ nonTerminalFirst: true });
  const r = await runToSettled(s);
  expect(r.turns).toBe(1);
}, 30_000);

test("the budget cap stops the run", async () => {
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0 });
  const r = await runToSettled(s);
  expect(r.state).toBe("capped");
  expect(r.stopped_because).toBe("max_usd");
}, 30_000);

// The turn cap is the primary cap: getSessionStats().cost reads 0 on
// subscription providers (zai OAuth), so a run bounded only by max_usd would
// never stop there. turnCostUsd:0 reproduces that provider exactly.
test("the turn cap stops the run even when the provider reports no cost at all", async () => {
  const s = setup({ turnCostUsd: 0.0 }, { maxTurns: 1 });
  const r = await runToSettled(s);
  expect(r.stopped_because).toBe("max_turns");
  expect(r.cost_usd).toBe(0);
}, 30_000);

test("locked paths are restored even when a cap fires", async () => {
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0, readonly: ["raw"] });
  mkdirSync(join(s.workdir, "raw"));
  writeFileSync(join(s.workdir, "raw", "a.txt"), "a");
  await runToSettled(s);
  expect(statSync(join(s.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

test("every frame is written to events.jsonl", async () => {
  const s = setup({});
  await runToSettled(s);
  const lines = readFileSync(join(s.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every(l => JSON.parse(l))).toBe(true);
}, 30_000);

// CARRY-OVER 1. finish() calls client.abort() on a cap breach, and both the
// fake and real omp answer abort with their own unsolicited agent_end. The
// event listener is deliberately still attached when that frame arrives (it
// is only unsubscribed in finish()'s finally block, once teardown is
// complete — CARRY-OVER 9) so the frame IS delivered to the handler: the
// `if (finishing) return` guard right after the frame is logged is what
// stops it being re-counted as a turn. v1 shipped a version of this test
// that passed with the guard deleted, because unsubscribing immediately
// closed the hole by a different route and made the guard unreachable.
//
// Verified by mutation: deleting the `if (finishing) return;` guard at the
// top of the onSessionEvent handler in src/runner.ts makes this test fail
// with `turns: 2`; restoring it passes.
test("an abort's own echoed agent_end does not double-count a turn", async () => {
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0 });
  const r = await runToSettled(s);
  expect(r.turns).toBe(1);
}, 30_000);

test("the wall clock stops a run whose single turn runs past max_seconds", async () => {
  const s = setup({ turnDelayMs: 2000 }, { maxSeconds: 1 });
  const r = await runToSettled(s);
  expect(r.stopped_because).toBe("max_seconds");
  expect(r.state).toBe("capped");
}, 30_000);

test("locked paths are restored after a normal completion", async () => {
  const s = setup({}, { readonly: ["raw"] });
  mkdirSync(join(s.workdir, "raw"));
  writeFileSync(join(s.workdir, "raw", "a.txt"), "a");
  const r = await runToSettled(s);
  expect(r.state).toBe("completed");
  expect(statSync(join(s.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

test("locked paths are restored after a start-up error", async () => {
  const s = setup({}, { readonly: ["raw"], command: ["bun", "/definitely/does/not/exist.ts"] });
  mkdirSync(join(s.workdir, "raw"));
  writeFileSync(join(s.workdir, "raw", "a.txt"), "a");
  const r = await runToSettled(s);
  expect(r.state).toBe("error");
  expect(r.stopped_because).toBe("error");
  expect(statSync(join(s.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
}, 30_000);

// CARRY-OVER 5. A turn that never emits a terminal agent_end must still be
// capped. turnDelayMs keeps the fake mid-turn (cost already booked, no
// agent_end yet) for 1000ms — long enough for a 50ms-interval poll to
// observe the breach on its own, independent of the per-turn check.
//
// v1 shipped a vacuous first version: with the poll body disabled, the
// per-turn check reaches the same capped/max_usd verdict, just later, so
// state/stopped_because alone cannot tell which path caught it. This version
// asserts two things only the poll can produce — the run finishes well under
// turnDelayMs, and progress.log carries the poll's own line.
//
// Verified by mutation: emptying the setInterval body makes both the
// elapsed-time and the log-line assertion fail; restoring it passes.
test("a periodic poll catches a budget breach mid-turn, before any agent_end", async () => {
  process.env.OMP_DISPATCH_POLL_MS = "50";
  try {
    const s = setup({ turnCostUsd: 5.0, turnDelayMs: 1000 }, { maxUsd: 1.0, maxSeconds: 300 });
    const t0 = Date.now();
    const r = await runToSettled(s);
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

// CARRY-OVER 4. A getSessionStats() failure that is swallowed leaves costUsd
// stale, and the budget cap then silently ceases to exist with nothing in the
// log. statsFailAfter makes the fake answer the first stats call and fail
// every one after it WITHOUT dying, so this is the escalation path and only
// the escalation path — a dead child would end the run by the separate
// child-exited route instead. The long turnDelayMs means no agent_end can
// arrive either, so the poll is the only thing noticing.
//
// Verified by mutation: making refreshStats() swallow the failure (return
// false without incrementing statsFailures) makes the run hang to the wall
// clock instead — state "capped"/max_seconds and neither log line present.
test("repeated stats failures end the run as an error instead of running on with a stale cost", async () => {
  process.env.OMP_DISPATCH_POLL_MS = "50";
  try {
    const s = setup({ statsFailAfter: 1, turnDelayMs: 8000 }, { maxSeconds: 300 });
    const t0 = Date.now();
    const r = await runToSettled(s);
    const elapsedMs = Date.now() - t0;
    expect(r.state).toBe("error");
    expect(r.stopped_because).toBe("error");
    expect(elapsedMs).toBeLessThan(3000);      // long before the turn's own 8000ms delay
    const log = readFileSync(join(s.runDir, "progress.log"), "utf8");
    expect(log).toContain("get_session_stats failed (3/3 consecutive)");
    expect(log).toContain("giving up after 3 consecutive stats failures");
  } finally {
    delete process.env.OMP_DISPATCH_POLL_MS;
  }
}, 30_000);

// A dead child is also the natural way to reach finish()'s own final
// getSessionStats() failing. That catch used to swallow, so the run could
// report a cost a full turn short with nothing in progress.log saying why.
//
// Verified by mutation: deleting the appendProgress from that catch in
// src/runner.ts makes the last assertion here fail; restoring it passes.
test("an omp child that dies mid-turn ends the run as an error, not a hang, and says the final stats were lost", async () => {
  process.env.OMP_DISPATCH_POLL_MS = "50";
  try {
    const s = setup({ crashAfterPrompt: true }, { maxSeconds: 300 });
    const r = await runToSettled(s);
    expect(r.state).toBe("error");
    expect(r.stopped_because).toBe("error");
    const log = readFileSync(join(s.runDir, "progress.log"), "utf8");
    expect(log).toContain("the final get_session_stats failed");
  } finally {
    delete process.env.OMP_DISPATCH_POLL_MS;
  }
}, 30_000);

// CARRY-OVER 6. unlockPaths and gitChangedSince can both genuinely throw (a
// chmod failure, `git status` failing) — the tail of finish() must not let
// either throw skip settled(result) or leave the run stuck at
// state:"running". Exercised here via gitChangedSince: make the workdir a
// real repo, then delete .git mid-run so the final `git status --porcelain`
// genuinely fails.
test("finish still settles and writes a result even if git status fails", async () => {
  const s = setup({ turnDelayMs: 300 });
  await Bun.$`git init -q`.cwd(s.workdir).quiet();

  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await new Promise(r => setTimeout(r, 100));
    rmSync(join(s.workdir, ".git"), { recursive: true, force: true });
    const r = await handle.settled;
    expect(r.state).toBe("completed");
    expect(r.files_changed).toEqual([]);
  } finally {
    await handle.dispose();
  }
}, 30_000);

// CARRY-OVER 5 (the other half): the poll must never be CREATED once
// `finishing` is set. The wall clock can fire while client.start() is still
// pending — finish() has then already run its cleanup by the time start()
// settles, finding costPoll not yet created, so clearInterval was a no-op.
// Creating the poll afterwards leaks an interval nothing will ever clear.
//
// Asserting on the RunResult alone is vacuous here: `settled` resolves fine
// either way. The real symptom is a process that never exits, so this runs
// the scenario in a separate process that deliberately never calls
// process.exit() and checks whether it exits by itself. dispose() is called
// first so the agent child is not what keeps it alive.
//
// Verified by mutation, three ways, each making the spawned process print
// RUN_SETTLED and then hang past the 6s budget (`hung: true`): reverting the
// `if (!finishing)` guard around the post-start() block so costPoll is always
// assigned; deleting `clearInterval(costPoll)` from finish(); deleting
// `clearTimeout(wallClock)` from finish(). With all three in place it exits
// on its own in well under a second.
test("neither the poll nor the wall clock survives a run, however that run ended", async () => {
  const scriptDir = mkdtempSync(join(tmpdir(), "omp-repro-"));
  const scriptPath = join(scriptDir, "repro.ts");
  const runnerPath = new URL("../src/runner.ts", import.meta.url).pathname;
  const rundirPath = new URL("../src/rundir.ts", import.meta.url).pathname;
  const fakePath = join(import.meta.dir, "fake-omp.ts");
  writeFileSync(scriptPath, `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun } from ${JSON.stringify(runnerPath)};
import { newRunId, createRunDir } from ${JSON.stringify(rundirPath)};

const workdir = mkdtempSync(join(tmpdir(), "omp-runner-"));
const runId = newRunId();
const runDir = createRunDir(workdir, runId);
process.env.FAKE_OMP_SCRIPT = JSON.stringify({ readyDelayMs: 1500 });
const handle = await startRun({
  prompt: "do it", model: "fake/fake-1", workdir, tools: "read",
  maxTurns: 120, maxUsd: 1.0, maxSeconds: 1,
  command: ["bun", ${JSON.stringify(fakePath)}],
}, runDir, runId);
await handle.settled;
await handle.dispose();

// A second, ordinary run that DOES get as far as creating the poll and the
// wall clock, so this also covers the other half of "cleared on every exit
// path": a normally-completed run must leave neither timer behind.
const workdir2 = mkdtempSync(join(tmpdir(), "omp-runner-"));
const runId2 = newRunId();
const runDir2 = createRunDir(workdir2, runId2);
process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
const handle2 = await startRun({
  prompt: "do it", model: "fake/fake-1", workdir: workdir2, tools: "read",
  maxTurns: 120, maxUsd: 1.0, maxSeconds: 300,
  command: ["bun", ${JSON.stringify(fakePath)}],
}, runDir2, runId2);
await handle2.settled;
await handle2.dispose();
console.log("RUN_SETTLED");
// Deliberately no process.exit(): a leaked, uncleared setInterval is exactly
// what would keep this process running past this point on its own.
`);

  const proc = Bun.spawn(["bun", scriptPath], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMP_DISPATCH_POLL_MS: "50" },
  });
  const outcome = await Promise.race([
    proc.exited.then(code => ({ hung: false as const, code })),
    Bun.sleep(6000).then(() => ({ hung: true as const })),
  ]);
  if (outcome.hung) proc.kill();
  const stdout = await new Response(proc.stdout).text().catch(() => "");

  expect(stdout).toContain("RUN_SETTLED");   // the run itself did settle
  expect(outcome.hung).toBe(false);          // and the process must exit on its own
}, 20_000);

// CARRY-OVER 7. rpc-client.ts:1117 calls the onSessionEvent listener bare,
// with nothing to catch a throw inside it, so an uncaught throw becomes an
// unhandled rejection: teardown never runs and the workspace stays locked.
// toolCallsPerTurn:0 plus turnDelayMs gives a clean gap between
// events.jsonl's creation (on agent_start) and its next write (on the
// delayed agent_end) to chmod it read-only in between, forcing a real EACCES.
//
// Verified by mutation: removing the handler's own try/catch makes the
// appendFileSync throw propagate uncaught through rpc-client.ts's
// #handleLine, the run never settles and the test times out.
test("a handler exception (e.g. events.jsonl becoming unwritable) still reaches teardown", async () => {
  const s = setup({ toolCallsPerTurn: 0, turnDelayMs: 300 }, { readonly: ["raw"] });
  mkdirSync(join(s.workdir, "raw"));
  writeFileSync(join(s.workdir, "raw", "a.txt"), "a");

  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await waitForProgress(s.runDir, "START");
    const eventsPath = join(s.runDir, "events.jsonl");
    await waitForFile(eventsPath);
    chmodSync(eventsPath, 0o444);
    const r = await handle.settled;
    expect(r.state).toBe("error");
    expect(statSync(join(s.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
  } finally {
    await handle.dispose();
  }
}, 30_000);

// CARRY-OVER 6 (the unlock half): reproduced the same way
// test/preflight.test.ts has done since v1 Task 2 — chmodSync(sub, 0o000) on
// a subdirectory already included in the run's own recursive lock makes the
// later `chmod -R u+w raw` fail trying to recurse into it, with no root.
// A failed unlock means the workspace may still be unwritable, which is more
// urgent than whatever originally stopped the run, so it overrides the
// reported outcome rather than being buried in a log line.
test("finish still settles as an error when unlockPaths itself fails (a real chmod failure, no root)", async () => {
  const s = setup({ turnDelayMs: 300 }, { readonly: ["raw"] });
  mkdirSync(join(s.workdir, "raw"));
  writeFileSync(join(s.workdir, "raw", "a.txt"), "a");
  const sub = join(s.workdir, "raw", "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "f.txt"), "x");

  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await waitForProgress(s.runDir, "START");
    chmodSync(sub, 0o000);   // owner can still set this; no root needed
    const r = await handle.settled;
    expect(r.state).toBe("error");
    expect(r.stopped_because).toBe("error");
    const log = readFileSync(join(s.runDir, "progress.log"), "utf8");
    expect(log).toContain("failed to unlock paths");
  } finally {
    await handle.dispose();
    chmodSync(sub, 0o700);   // restore so the tmp dir can be cleaned up normally
  }
}, 30_000);

// CARRY-OVER 8. omp's bash tool calls are DESCENDANTS of the agent process,
// not the agent itself. A kill that reaches only the direct child leaves them
// running against a workspace the run has finished with. spawnGrandchild
// stands in for one: a real descendant process, not a fake frame.
//
// Verified by mutation: replacing the process-group kill in spawnAgent's
// kill() with a bare `proc.kill(signal)` (and dropping `detached: true`)
// leaves the grandchild ALIVE after dispose() returns, failing the final
// assertion; with the group kill restored it is gone.
test("dispose kills omp's whole process tree, not just the direct agent process", async () => {
  const s = setup({ spawnGrandchild: true, turnDelayMs: 5000 });
  const handle = await startRun(s.opts, s.runDir, s.runId);
  let gcPid = 0;
  try {
    const pidFile = join(s.workdir, "grandchild.pid");
    await waitForFile(pidFile);
    gcPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(gcPid)).toBe(true);   // sanity: the descendant actually started
  } finally {
    await handle.dispose();
  }

  const deadline = Date.now() + 3000;
  while (isAlive(gcPid) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  expect(isAlive(gcPid)).toBe(false);
}, 30_000);

test("the run's agent is launched in the workdir with the tools, system prompt and max-time it was given", async () => {
  const dumpDir = mkdtempSync(join(tmpdir(), "omp-dump-"));
  const dump = join(dumpDir, "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  try {
    const s = setup({}, { tools: "read,edit", systemPrompt: "you are a reviewer", maxSeconds: 300 });
    await runToSettled(s);
    const launched = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; cwd: string };
    expect(launched.argv).toContain("--tools=read,edit");
    expect(launched.argv).toContain("--append-system-prompt=you are a reviewer");
    // Always longer than the runner's own wall clock, so the runner wins that
    // race and reports max_seconds itself rather than the two racing
    // non-deterministically over which gets to explain why the run stopped.
    expect(launched.argv).toContain("--max-time=360");
    // realpath on both sides: macOS resolves /var/folders/... to /private/var/...
    expect(launched.cwd).toBe(realpathSync(s.workdir));
  } finally {
    delete process.env.FAKE_OMP_DUMP;
  }
}, 30_000);

// A follow-up must not be answered by a run that has already been settled out
// from under it, and must not hang waiting for a turn that will never come.
// Resuming a settled run is deliberately out of scope here (see the runner's
// own comment on say()): the contract this task fixes is that it FAILS
// loudly, naming the run, rather than hanging.
// steer() interrupts a turn in flight, so it has nothing to interrupt once a
// run has settled and still fails loudly. say() is different now: resuming a
// COMPLETED run is supported (see the resume tests below), so only a run that
// stopped for some other reason refuses it.
test("steer on a settled run fails loudly, naming the run", async () => {
  const s = setup({});
  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await handle.settled;
    await expect(handle.steer("stop")).rejects.toThrow(s.runId);
  } finally {
    await handle.dispose();
  }
}, 30_000);

// A pending follow-up must not be settled away by the turn that precedes it:
// the agent_end handler reaching finish("completed") while a say() is
// outstanding would end the very run say() was trying to continue.
test("a follow-up keeps the run alive past the turn that was already in flight", async () => {
  const s = setup({ turnDelayMs: 400, replies: ["first", "second"] }, { maxTurns: 5 });
  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    const reply = await handle.say("and now the second thing");
    const r = await handle.settled;
    expect(r.turns).toBe(2);
    expect(r.state).toBe("completed");
    expect(reply).toBe("second");
  } finally {
    await handle.dispose();
  }
}, 30_000);

// A cap firing while a say() is outstanding must release it. Without that,
// the caller waits forever for a turn the run has already been stopped from
// taking.
test("a cap firing while a follow-up is outstanding releases it rather than hanging", async () => {
  const s = setup({ turnCostUsd: 5.0, turnDelayMs: 200 }, { maxUsd: 1.0 });
  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await handle.say("keep going");
    const r = await handle.settled;
    expect(r.stopped_because).toBe("max_usd");
  } finally {
    await handle.dispose();
  }
}, 30_000);

// CARRY-OVER 9. The onSessionEvent unsubscribe must actually be CALLED, and
// called in teardown rather than up front. Up front makes the double-count
// guard unreachable (see the abort-echo test above); never calling it at all
// leaves a listener on a client that now outlives the run — under an MCP
// server the agent process survives until dispose(), so frames really do
// keep arriving after the END line. The frame this waits for lands 1300ms
// after the run settles, long past anything finish() could still be
// flushing, so a growing events.jsonl can only mean a live listener.
//
// Verified by mutation: deleting `unsubscribeEvents?.()` from finish()'s
// finally block makes events.jsonl grow after the run has settled and this
// test fails; restoring it passes. Note the `finishing` guard does NOT cover
// this — the append happens before that guard, deliberately, for the audit
// trail.
test("the session-event listener is unsubscribed in teardown, so no frame is recorded after the run settles", async () => {
  const s = setup({ turnDelayMs: 1500 });
  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await waitForProgress(s.runDir, "START");
    await handle.stop();
    await handle.settled;
    const eventsPath = join(s.runDir, "events.jsonl");
    const atSettle = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
    await new Promise(r => setTimeout(r, 2500));   // outlasts the fake's own 1500ms turn
    const later = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
    expect(later).toBe(atSettle);
  } finally {
    await handle.dispose();
  }
}, 30_000);

// dispose() racing a settle that is ALREADY in flight: finish() returns
// immediately in that case, so dispose must wait for the settle itself
// before killing the tree. Killing it mid-teardown rejects the pending
// getSessionStats and getLastAssistantText, and the run then reports a cost
// short by the whole turn — the one number that gates spend.
//
// The window is deterministic, not a race: client.stop() rejects every
// pending request synchronously. turnDelayMs holds the turn open so no
// agent_end has refreshed the cost yet, and the 15s default poll never
// fires, so the ONLY read of this turn's cost is the one in finish().
//
// Verified by mutation: deleting the `await done;` from dispose() makes both
// assertions fail — cost_usd 0 instead of 0.07, last_reply null instead of
// "the whole story"; restoring it passes.
test("disposing during a settle already in flight still reports the full cost and reply", async () => {
  const s = setup({ turnCostUsd: 0.07, turnDelayMs: 3000, replies: ["the whole story"] });
  const handle = await startRun(s.opts, s.runDir, s.runId);
  await waitForProgress(s.runDir, "START");
  expect(handle.result.cost_usd).toBe(0);   // nothing has read this turn's cost yet

  const stopping = handle.stop();           // deliberately not awaited: a settle is now in flight
  await handle.dispose();
  await stopping;

  const r = await handle.settled;
  expect(r.cost_usd).toBeCloseTo(0.07, 5);
  expect(r.last_reply).toBe("the whole story");
}, 30_000);

// stop() settles the run as aborted without releasing the handle; dispose()
// is what releases it. The two being separate is what lets the MCP server own
// the agent process for longer than the run that started it.
test("stop settles the run as aborted and restores locked paths", async () => {
  const s = setup({ turnDelayMs: 5000 }, { readonly: ["raw"] });
  mkdirSync(join(s.workdir, "raw"));
  writeFileSync(join(s.workdir, "raw", "a.txt"), "a");

  const handle = await startRun(s.opts, s.runDir, s.runId);
  try {
    await waitForProgress(s.runDir, "START");
    await handle.stop();
    const r = await handle.settled;
    expect(r.state).toBe("aborted");
    expect(r.stopped_because).toBe("aborted");
    expect(statSync(join(s.workdir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
  } finally {
    await handle.dispose();
  }
}, 30_000);

// --- Task 8: resuming a settled run -------------------------------------

test("say() resumes a run that completed, and the reply is the new turn's", async () => {
  const s = setup({ turnCostUsd: 0.01, replies: ["first", "second"] });
  const h = await startRun(s.opts, s.runDir, s.runId);
  const first = await h.settled;
  expect(first.state).toBe("completed");
  // settled resolves with the SAME object the handle keeps mutating, so a
  // reference is not a snapshot — read the number out before resuming.
  const turnsBefore = first.turns;

  const reply = await h.say("carry on");
  expect(reply).toBe("second");
  expect(h.result.state).toBe("completed");
  expect(h.result.turns).toBeGreaterThan(turnsBefore);
  await h.dispose();
}, 40_000);

// seconds is the time the AGENT spent working, summed across turns — not wall
// time including however long the supervisor sat idle between them. So give
// each turn real duration rather than sleeping between them.
test("resuming accumulates seconds across turns rather than resetting", async () => {
  const s = setup({ turnCostUsd: 0.01, replies: ["a", "b"], turnDelayMs: 1100 });
  const h = await startRun(s.opts, s.runDir, s.runId);
  const first = await h.settled;
  const secondsBefore = first.seconds;   // same object as h.result; snapshot it
  expect(secondsBefore).toBeGreaterThanOrEqual(1);
  await h.say("again");
  expect(h.result.seconds).toBeGreaterThanOrEqual(secondsBefore + 1);
  await h.dispose();
}, 40_000);

test("say() refuses on a capped run, naming the reason", async () => {
  const s = setup({ turnCostUsd: 5.0 }, { maxUsd: 1.0 });
  const h = await startRun(s.opts, s.runDir, s.runId);
  const r = await h.settled;
  expect(r.stopped_because).toBe("max_usd");
  await expect(h.say("more")).rejects.toThrow(/max_usd/);
  await h.dispose();
}, 40_000);

test("say() refuses after dispose()", async () => {
  const s = setup({ turnCostUsd: 0.01 });
  const h = await startRun(s.opts, s.runDir, s.runId);
  await h.settled;
  await h.dispose();
  await expect(h.say("more")).rejects.toThrow(/dispose/);
}, 40_000);

test("a resumed run that breaches a cap settles capped, not completed", async () => {
  const s = setup({ turnCostUsd: 0.6 }, { maxUsd: 1.0 });
  const h = await startRun(s.opts, s.runDir, s.runId);
  await h.settled;                       // 0.6 < 1.0, completes
  await h.say("again").catch(() => {});  // cumulative 1.2 >= 1.0
  expect(h.result.stopped_because).toBe("max_usd");
  await h.dispose();
}, 40_000);

// An ABORTED run isolates the state guard: unlike a capped one, its cost is
// nowhere near max_usd, so breach() would let it through. Only the
// stopped_because check refuses it.
test("say() refuses on an aborted run, naming the reason", async () => {
  const s = setup({ turnCostUsd: 0.01, turnDelayMs: 3000 });
  const h = await startRun(s.opts, s.runDir, s.runId);
  await h.stop();
  await h.settled;
  expect(h.result.stopped_because).toBe("aborted");
  await expect(h.say("more")).rejects.toThrow(/aborted/);
  await h.dispose();
}, 40_000);
