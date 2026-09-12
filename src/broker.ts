import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
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
// grace before giving up. Shared by the per-turn check and the poll, so a
// child that starts failing mid-turn can't quietly bypass the cap either
// way it's noticed.
const MAX_STATS_FAILURES = 3;

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

  // Repair a stale lock from a previous kill -9. Best-effort: if the tree is
  // broken badly enough that even the repair-unlock can't walk it, log it
  // and still try lockPaths below — its own guard (see I5) is what actually
  // decides whether this run can proceed.
  try {
    await unlockPaths(task.workdir, task.readonly);
  } catch (e) {
    appendProgress(runDir, `ERROR failed to repair a stale lock: ${String(e)}`);
  }
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

  // A custom spawn instead of RpcClientOptions' command/cliPath so this can
  // hold on to the child's own `exited` promise — RpcClient's `#process` is
  // a private field with no public getter, but `exited` on the object this
  // returns is the same hook a caller-owned process would have.
  //
  // `detached: true` calls setsid() on POSIX, making the agent process both
  // a new session leader and the leader of a fresh process group (pgid ==
  // its own pid). Anything IT spawns without detaching itself again — in
  // particular every bash tool call omp runs — inherits that same pgid.
  // Killing by PID alone (RpcClient's default ptree.spawn-backed transport
  // uses Process.terminate(), which kills descendants; a bare
  // `proc.kill()` here would not) only reaches the direct child and leaves
  // those descendants running against a workspace teardown just unlocked.
  // Signaling the negative PID targets the whole group instead.
  let childExited: Promise<number> | undefined;
  const spawnAgent = (agentArgs: string[]): RpcAgentProcess => {
    const argv = [...(opts.command ?? ["bun", opts.cliPath ?? OMP_CLI]), ...agentArgs];
    const proc = Bun.spawn(argv, {
      cwd: task.workdir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: emptyConfig } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      detached: true,
    });

    let stderrTail = "";
    const stderrDrained = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-32768);
        }
      } catch { /* the pipe just closes when the child exits */ }
    })();

    // rpc-client.ts's own exit handling (see its comment around the 250ms
    // race in start()) assumes `exited` only settles once the stderr tail
    // is complete, so a startup failure's error message always carries the
    // real stderr instead of an empty one read too early. Bun's raw
    // `proc.exited` alone doesn't wait for our own background drain loop
    // above to finish; chain it so peekStderr() is never read mid-drain.
    const exited = proc.exited.then(async code => {
      await stderrDrained.catch(() => {});
      return code;
    });
    childExited = exited;

    const killGroup = (signal: number | NodeJS.Signals) => {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        // The group may already be empty/gone, or (unexpectedly) killing by
        // group may not be available — fall back to the direct child so a
        // real failure here isn't silently swallowed.
        try { proc.kill(signal); } catch { /* already dead */ }
      }
    };

    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      peekStderr: () => stderrTail,
      kill: (signal, graceMs) => {
        killGroup((signal as number | NodeJS.Signals | undefined) ?? "SIGTERM");
        if (graceMs !== undefined && graceMs >= 0) {
          const escalate = setTimeout(() => {
            if (proc.exitCode === null) killGroup("SIGKILL");
          }, graceMs);
          escalate.unref?.();
        }
      },
      exited,
    };
  };

  const client = new RpcClient({
    spawn: spawnAgent,
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
    // The wall clock, poll and signal handlers are stopped immediately —
    // nothing depends on them firing again. The session-event listener is
    // deliberately NOT unsubscribed yet (see the finally block): client
    // .abort() below makes the fake (and real omp) emit its own unsolicited
    // agent_end, and the handler's own `if (finishing) return` guard —
    // checked against the flag just set above — is what stops that frame
    // from being double-counted as a turn. Unsubscribing here instead would
    // make that guard unreachable and this exact regression untestable.
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
      // state:"running". Unsubscribe happens here, once, guaranteed — see
      // the comment above for why it isn't earlier.
      unsubscribeEvents?.();
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
  // exactly how the budget cap would quietly stop enforcing itself. Shared
  // by the per-turn handler and the poll below, so a stats failure is caught
  // no matter which one happens to notice it first.
  async function refreshStats(): Promise<boolean> {
    try {
      const s = await client.getSessionStats();
      state.costUsd = s.cost;
      result.cost_usd = s.cost;
      result.tool_calls = s.toolCalls;
      statsFailures = 0;
      return true;
    } catch (e) {
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
    // rpc-client.ts calls this listener bare (no try/catch of its own), so
    // an uncaught throw anywhere below — even a plain fs error appending to
    // events.jsonl — would become an unhandled rejection: finish() would
    // never run, and the run would drift to the wall clock with the
    // workspace still locked. Route any such throw to the same teardown.
    try {
      appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
      // Once a settle is under way, no more progress-log lines or turn
      // accounting — a stray frame from the abort finish() just issued
      // (still logged above, for the audit trail) must not log a tool_start
      // or double-count a turn after the END line has already been written.
      // This is deliberately checked here, before unsubscribing (which
      // happens later, in finish()'s finally) — see the comment there.
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
    } catch (e) {
      if (!finishing) {
        appendProgress(runDir, `ERROR the session-event handler threw: ${String(e)}`);
        await finish("error").catch(() => {});
      }
    }
  });

  wallClock = setTimeout(() => void finish("max_seconds"), task.maxSeconds * 1000);

  try {
    await client.start();

    // A signal or the wall clock can fire while start() above is still
    // pending — finish() already ran its cleanup by the time start()
    // settles, finding costPoll (and everything below) not created yet.
    // Nothing past this point may still run in that case: creating the poll
    // anyway would leak an interval nothing will ever clear, calling
    // getState()/prompt() would restart work on a client finish() is
    // already tearing down.
    if (!finishing) {
      // The real hook for "did the child die unexpectedly": spawnAgent
      // above captured the same `exited` promise a caller-owned process
      // would have. finish() itself kills the child as part of normal
      // teardown, but by then `finishing` is already true, so this is a
      // no-op on the expected path.
      if (childExited) {
        void childExited.then(code => {
          if (finishing) return;
          appendProgress(runDir, `ERROR the omp process exited unexpectedly (code ${code})`);
          void finish("error");
        });
      }

      // Catches what the turn-based check above cannot: a turn that never
      // emits a terminal agent_end (looping on tool calls, or just slow)
      // would otherwise escape both the turn cap and the budget cap
      // entirely. Shares refreshStats() (and its failure counter) with the
      // per-turn handler rather than reading stats independently, so a
      // child that starts failing mid-turn is caught the same way either
      // path notices it, and shares `state` rather than a separate copy —
      // both are only ever mutated after a `finishing` check, the same
      // protection the per-turn handler relies on.
      costPoll = setInterval(() => {
        if (finishing) return;
        void (async () => {
          const ok = await refreshStats();
          if (finishing || !ok) return;
          const b = breach(state, caps);
          if (b) {
            appendProgress(runDir, `POLL breach detected mid-turn: ${b} ($${state.costUsd.toFixed(4)})`);
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
    }
  } catch (e) {
    if (!finishing) {
      appendProgress(runDir, `ERROR ${String(e)}`);
      await finish("error");
    }
  }

  return done;
}
