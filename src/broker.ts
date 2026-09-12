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
  /** Override the agent launcher. Tests point this at test/fake-omp.ts. */
  command?: string[];
  cliPath?: string;
}

const OMP_CLI =
  "/Users/jamie/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";

// A stats call that fails this many times in a row means something is
// genuinely wrong (not a one-off blip) — see the "budget cap silently
// disappears" finding. Small on purpose: 3 gives one or two turns' worth of
// grace before giving up.
const MAX_STATS_FAILURES = 3;

/** True when the RPC client threw because it has no live child at all — not a
 * transient error, but proof the omp process is gone. rpc-client.ts's #send
 * throws this exact message synchronously whenever `#process` is null. */
function isClientDead(e: unknown): boolean {
  return e instanceof Error && e.message === "Client not started";
}

export async function runBroker(opts: BrokerOptions): Promise<RunResult> {
  const { task, runDir, runId } = opts;
  const result = emptyResult(runId);
  const caps: Caps = {
    maxTurns: task.maxTurns, maxUsd: task.maxUsd, maxSeconds: task.maxSeconds,
  };
  const state = newCapState();

  // How often the budget/turn/wall-clock caps are checked even when no
  // terminal agent_end has arrived — e.g. a single turn stuck looping on
  // tool calls. Overridable via env for tests; 15s is the production
  // default. Read per-call, not module-level: a module-level const would be
  // frozen at import time, before a test ever gets a chance to set the env
  // var — found the hard way when a "50ms poll" test took 15 real seconds.
  const pollIntervalMs = Number(process.env.OMP_DISPATCH_POLL_MS) || 15_000;

  writeFileSync(join(runDir, "broker.pid"), String(process.pid));
  writeResult(runDir, result);

  // An empty CLAUDE_CONFIG_DIR is free insurance; --tools= is what actually
  // shrinks the surface. See spec section 15.
  const emptyConfig = join(runDir, "no-claude-config");
  mkdirSync(emptyConfig, { recursive: true });

  // Repair a stale lock from a previous kill -9, then lock for this run.
  await unlockPaths(task.workdir, task.readonly);
  const before = await gitSnapshot(task.workdir);

  // lockPaths is inside its own guard: a chmod failure partway through a
  // multi-path readonly list must not leave whatever DID lock stuck with no
  // unlock attempted and no result written. Nothing has started yet (no
  // client, no child process), so this is a self-contained early return
  // rather than routed through the general finish() below.
  try {
    await lockPaths(task.workdir, task.readonly);
  } catch (e) {
    appendProgress(runDir, `ERROR failed to lock paths: ${String(e)}`);
    await unlockPaths(task.workdir, task.readonly).catch(() => {});
    result.files_changed = await gitChangedSince(task.workdir, before).catch(() => []);
    result.stopped_because = "error";
    result.state = "error";
    writeResult(runDir, result);
    appendProgress(runDir, "END error — failed to lock paths before starting");
    return result;
  }

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
      // Always longer than the broker's own wall clock below, so the broker
      // always wins that race and reports max_seconds itself instead of the
      // two racing non-deterministically over which one gets to explain why
      // the run stopped.
      `--max-time=${task.maxSeconds + 60}`,
    ],
  });

  let settled: (r: RunResult) => void;
  const done = new Promise<RunResult>(res => { settled = res; });
  let finishing = false;
  let statsFailures = 0;

  let unsubscribeEvents: (() => void) | undefined;
  let wallClock: ReturnType<typeof setTimeout> | undefined;
  let costPoll: ReturnType<typeof setInterval> | undefined;

  const onSignal = (sig: string) => {
    appendProgress(runDir, `SIGNAL ${sig} received — aborting and restoring the workspace`);
    void finish("aborted");
  };

  const finish = async (stopped: NonNullable<RunResult["stopped_because"]>) => {
    if (finishing) return;
    finishing = true;
    // Nothing below may call finish() again or keep the process alive on its
    // own: stop listening/polling/signalling before doing anything else, so
    // an in-flight competing trigger (the poll, a signal, the wall clock)
    // can't race this settle.
    unsubscribeEvents?.();
    clearTimeout(wallClock);
    clearInterval(costPoll);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    try {
      if (stopped !== "completed") await client.abort().catch(() => {});
      try {
        const s = await client.getSessionStats();
        result.cost_usd = s.cost;
        result.tool_calls = s.toolCalls;
        result.session_file = s.sessionFile ?? null;
        result.last_reply = await client.getLastAssistantText();
      } catch { /* the child may already be gone; keep what we have */ }
      await client.stop().catch(() => {});

      // From here on nothing may skip settled(result) or leave the workspace
      // locked: unlockPaths and gitChangedSince can both genuinely throw
      // (a chmod failure, or `git status` failing), so each gets its own
      // guard instead of one bare await that would abandon the rest of the
      // teardown — and, in the unlock case, leave paths unwritable forever.
      let unlockFailed = false;
      try {
        await unlockPaths(task.workdir, task.readonly);
      } catch (e) {
        unlockFailed = true;
        appendProgress(runDir, `ERROR failed to unlock paths — workspace may still be read-only: ${String(e)}`);
      }
      try {
        result.files_changed = await gitChangedSince(task.workdir, before);
      } catch (e) {
        appendProgress(runDir, `ERROR failed to compute files_changed: ${String(e)}`);
      }

      result.seconds = Math.round((Date.now() - state.startedAt) / 1000);
      result.turns = state.turns;
      // A failed unlock means the workspace may still be unwritable — a more
      // urgent fact than whatever originally stopped the run, so it overrides
      // the reported outcome instead of being buried in a log line only.
      result.stopped_because = unlockFailed ? "error" : stopped;
      result.state = unlockFailed ? "error" : (
        stopped === "completed" ? "completed"
        : stopped === "aborted" ? "aborted"
        : stopped === "error" ? "error"
        : stopped === "asking" ? "asking"
        : "capped");
    } finally {
      // settled(result) and a best-effort write/log must happen regardless of
      // what threw above — an unhandled throw here would leave `done` (and
      // runBroker's caller) hanging forever with result.json stuck at
      // state:"running".
      try { writeResult(runDir, result); } catch { /* best effort */ }
      try {
        appendProgress(runDir, `END ${result.stopped_because} — $${result.cost_usd.toFixed(4)}, ${result.turns} turns`);
      } catch { /* best effort */ }
      settled(result);
    }
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Refreshes cost/tool-call numbers from omp's own count — never trust
  // frames for this. Returns false when the read failed, so callers know not
  // to act on breach() with a number that never moved. A consecutive-failure
  // count on top of that stops the run outright after a handful of misses,
  // rather than silently running on forever against a stale cost — which is
  // exactly how the budget cap would quietly stop enforcing itself.
  async function refreshStats(): Promise<boolean> {
    try {
      const s = await client.getSessionStats();
      state.costUsd = s.cost;
      result.cost_usd = s.cost;
      result.tool_calls = s.toolCalls;
      statsFailures = 0;
      return true;
    } catch (e) {
      if (isClientDead(e)) {
        appendProgress(runDir, `ERROR the omp process is no longer running: ${String(e)}`);
        await finish("error");
        return false;
      }
      statsFailures++;
      appendProgress(
        runDir,
        `ERROR get_session_stats failed (${statsFailures}/${MAX_STATS_FAILURES} consecutive): ${String(e)}`,
      );
      if (statsFailures >= MAX_STATS_FAILURES) {
        appendProgress(runDir, `ERROR giving up after ${statsFailures} consecutive stats failures`);
        await finish("error");
      }
      return false;
    }
  }

  unsubscribeEvents = client.onSessionEvent(async (event: any) => {
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    // Once a settle is under way the listener is about to be (or already is
    // being) removed above; this covers the narrow window where THIS
    // invocation was already running before that happened. No more
    // progress-log lines or turn accounting once we're ending — otherwise a
    // stray frame from the abort we just issued could log a tool_start (or
    // double-count a turn) after the END line has already been written.
    if (finishing) return;

    const ev = event.assistantMessageEvent;
    if (ev?.type === "tool_start") {
      appendProgress(runDir, `${ev.name} ${String(JSON.stringify(ev.input ?? "")).slice(0, 70)}`);
    }

    if (event.type !== "agent_end") return;
    if (!countTurn(state, event)) return;    // isTerminal:false is not a turn

    const ok = await refreshStats();
    if (finishing) return;                   // refreshStats() may have already ended the run
    result.turns = state.turns;
    writeResult(runDir, result);
    appendProgress(runDir, `turn ${state.turns} — $${state.costUsd.toFixed(4)}`);
    if (!ok) return;

    const b = breach(state, caps);
    await finish(b ?? "completed");
  });

  wallClock = setTimeout(() => void finish("max_seconds"), task.maxSeconds * 1000);

  try {
    await client.start();

    // Catches what the turn-based check above cannot: a turn that never
    // emits a terminal agent_end (looping on tool calls, or just slow) would
    // otherwise escape both the turn cap and the budget cap entirely. This
    // poll is deliberately read-only against `state`/`result` — it takes its
    // own snapshot instead of mutating the shared cap state that the turn
    // handler owns, so it cannot race that handler the way an earlier draft
    // of this file raced itself over turn counts. finish() re-reads stats
    // itself, so the final numbers are correct regardless of which path
    // triggered it.
    costPoll = setInterval(() => {
      if (finishing) return;
      void (async () => {
        let stats: Awaited<ReturnType<typeof client.getSessionStats>>;
        try {
          stats = await client.getSessionStats();
        } catch (e) {
          if (isClientDead(e)) {
            appendProgress(runDir, `ERROR the omp process is no longer running: ${String(e)}`);
            await finish("error");
          } else {
            appendProgress(runDir, `ERROR periodic get_session_stats failed: ${String(e)}`);
          }
          return;
        }
        if (finishing) return;               // a settle may have started while this was in flight
        const probe = { ...state, costUsd: stats.cost };
        const b = breach(probe, caps);
        if (b) {
          appendProgress(runDir, `POLL breach detected mid-turn: ${b} ($${stats.cost.toFixed(4)})`);
          await finish(b);
        }
      })();
    }, pollIntervalMs);

    const st = await client.getState();
    result.model = st.model ? { provider: st.model.provider, id: st.model.id } : null;
    result.session_file = st.sessionFile ?? null;
    writeResult(runDir, result);
    appendProgress(runDir, `START ${task.model}`);
    await client.prompt(task.body);
  } catch (e) {
    appendProgress(runDir, `ERROR ${String(e)}`);
    await finish("error");
  }

  return done;
}
