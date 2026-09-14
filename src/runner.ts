import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, type RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
  type RunResult, emptyResult, writeResult, appendProgress, writeDiff,
} from "./rundir.ts";
import { lockPaths, unlockPaths, gitSnapshot, gitDiffSince } from "./preflight.ts";
import { newCapState, countTurn, breach, type Caps } from "./caps.ts";
import { createAskSupervisor } from "./asktool.ts";

export interface RunOptions {
  prompt: string;
  /** The dispatch-chosen name, persisted into result.json for disk readers. */
  name?: string;
  /** Already resolved by src/models.ts — `provider/id`, or a bare id. */
  model: string;
  workdir: string;
  tools: string;
  maxTurns: number;
  maxUsd: number;
  maxSeconds: number;
  /** The agent definition's body, appended to omp's own system prompt. */
  systemPrompt?: string;
  /** Paths under workdir to make read-only for the run. Off by default. */
  readonly?: string[];
  /** Override the agent launcher. Tests point this at test/fake-omp.ts. */
  command?: string[];
  env?: Record<string, string>;
}

export interface RunHandle {
  runId: string;
  /** Where this run's progress.log and result.json live. */
  runDir: string;
  /** The live result object — mutated as the run progresses. */
  result: RunResult;
  /** Resolves once the run has settled, whatever stopped it. */
  settled: Promise<RunResult>;
  /** Queue a follow-up; resolves with the reply once the run settles again. */
  say(text: string): Promise<string>;
  /** Interrupt the turn in flight with a steering message. */
  steer(text: string): Promise<void>;
  /** Settle the run as aborted. The agent process stays until dispose(). */
  stop(): Promise<void>;
  /** Answer a parked ask_supervisor question. False if none is waiting by that id. */
  answer(askId: string, text: string): boolean;
  /** Settle if still running, then kill omp and everything it spawned. */
  dispose(): Promise<void>;
}

/**
 * How to launch omp. Resolved at call time, never hardcoded: a fixed path to
 * one machine's bun install is exactly the kind of thing that works for the
 * author and nobody else.
 *
 * `omp` on PATH is the answer whenever it is there, which is the documented
 * requirement for this plugin. The package-relative fallback covers a checkout
 * whose dependencies are installed but where the binary was never linked.
 */
function ompCommand(): string[] {
  const onPath = Bun.which("omp");
  if (onPath) return [onPath];
  try {
    return ["bun", Bun.fileURLToPath(
      import.meta.resolve("@oh-my-pi/pi-coding-agent/dist/cli.js"),
    )];
  } catch {
    throw new Error(
      "cannot find omp: it is not on PATH and @oh-my-pi/pi-coding-agent is not " +
      "resolvable from this plugin. Install omp and make sure `omp --version` works.",
    );
  }
}

// A stats call that fails this many times in a row means something is
// genuinely wrong (not a one-off blip) — see the "budget cap silently
// disappears" finding. Small on purpose: 3 gives one or two turns' worth of
// grace before giving up. Shared by the per-turn check and the poll, so a
// child that starts failing mid-turn can't quietly bypass the cap either
// way it's noticed.
const MAX_STATS_FAILURES = 3;

// How long a SIGTERM'd process tree gets before the whole group is
// escalated to SIGKILL. Passed to RpcClient explicitly: it forwards
// `terminationGraceMs` straight to our own kill() below, and leaving it
// undefined would mean SIGTERM only — no escalation at all — for a
// descendant that ignores it.
const TERMINATION_GRACE_MS = 2_000;

/**
 * The CLI flags passed to the dispatched omp agent, beyond provider/model
 * (which RpcClient adds itself). Pure and exported so profile changes — what
 * a dispatched agent is and isn't allowed to use — can be tested directly
 * against the argv, without spawning anything.
 */
export function buildOmpArgs(
  opts: Pick<RunOptions, "tools" | "systemPrompt" | "maxSeconds">,
): string[] {
  return [
    `--tools=${opts.tools}`,
    ...(opts.systemPrompt ? [`--append-system-prompt=${opts.systemPrompt}`] : []),
    // --no-skills, --no-rules and --no-extensions are deliberately NOT here.
    // omp already loads its own skills, rules, extensions and MCP servers by
    // default; a dispatched agent should use them. --no-lsp and --no-pty stay
    // — they're runtime noise, not capabilities.
    "--no-lsp", "--no-pty",
    // Always longer than our own wall clock below, so this runner always
    // wins that race and reports max_seconds itself instead of the two
    // racing non-deterministically over which one gets to explain why the
    // run stopped.
    `--max-time=${opts.maxSeconds + 60}`,
  ];
}

/**
 * Start one omp run and hand back a handle to it.
 *
 * Unlike v1's broker this is NOT a daemon: the MCP server is the long-lived
 * process, holds the handle in memory and disposes it on shutdown. There is
 * no pidfile, no socket and no signal handling here. What v1's four review
 * rounds did buy — the double-count guard, stats-failure escalation, the
 * periodic cap poll, protected teardown and killing omp's whole process
 * tree — is all still here, because every one of them was a defect found
 * the hard way.
 */
export async function startRun(
  opts: RunOptions,
  runDir: string,
  runId: string,
): Promise<RunHandle> {
  const result = emptyResult(runId);
  result.name = opts.name ?? null;
  const readonly = opts.readonly ?? [];
  const caps: Caps = {
    maxTurns: opts.maxTurns, maxUsd: opts.maxUsd, maxSeconds: opts.maxSeconds,
  };
  const state = newCapState();

  // How often the budget/turn/wall-clock caps are checked even when no
  // terminal agent_end has arrived — e.g. a single turn stuck looping on
  // tool calls. Overridable via env for tests; 15s is the production
  // default. Read per-call, not module-level: a module-level const would be
  // frozen at import time, before a test ever gets a chance to set the env
  // var — found the hard way when a "50ms poll" test took 15 real seconds.
  const pollIntervalMs = Number(process.env.OMP_DISPATCH_POLL_MS) || 15_000;

  writeResult(runDir, result);

  // An empty CLAUDE_CONFIG_DIR is free insurance; --tools= is what actually
  // shrinks the surface. See spec section 15.
  const emptyConfig = join(runDir, "no-claude-config");
  mkdirSync(emptyConfig, { recursive: true });

  // Repair a stale lock from a previous kill -9. Best-effort: if the tree is
  // broken badly enough that even the repair-unlock can't walk it, log it
  // and still try lockPaths below — its own guard is what actually decides
  // whether this run can proceed.
  try {
    await unlockPaths(opts.workdir, readonly);
  } catch (e) {
    appendProgress(runDir, `ERROR failed to repair a stale lock: ${String(e)}`);
  }
  const before = await gitSnapshot(opts.workdir);

  // lockPaths is inside its own guard: a chmod failure partway through a
  // multi-path readonly list must not leave whatever DID lock stuck with no
  // unlock attempted and no result written. Nothing has started yet (no
  // client, no child process), so this is a self-contained early return
  // rather than routed through the general finish() below.
  try {
    await lockPaths(opts.workdir, readonly);
  } catch (e) {
    appendProgress(runDir, `ERROR failed to lock paths: ${String(e)}`);
    await unlockPaths(opts.workdir, readonly).catch(() => {});
    result.files_changed = (await gitDiffSince(opts.workdir, before).catch(() => null))?.files ?? [];
    result.stopped_because = "error";
    result.state = "error";
    writeResult(runDir, result);
    appendProgress(runDir, "END error — failed to lock paths before starting");
    const neverStarted = async () => {
      throw new Error(`run ${runId}: never started — failed to lock paths under ${opts.workdir}`);
    };
    return {
      runId, runDir, result, settled: Promise.resolve(result),
      say: neverStarted, steer: neverStarted, answer: () => false,
      stop: async () => {}, dispose: async () => {},
    };
  }

  const [provider, id] = opts.model.includes("/")
    ? opts.model.split("/") as [string, string]
    : [undefined, opts.model];

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
  // uses Process.terminate(), which kills descendants; a bare `proc.kill()`
  // here would not) only reaches the direct child and leaves those
  // descendants running against a workspace teardown has finished with.
  // Signaling the negative PID targets the whole group instead.
  //
  // This is the one piece of "detached spawn" machinery that stays. It is
  // not daemon machinery — nothing here detaches the HOST — it is the
  // mechanism that makes the descendant kill reach omp's bash tool calls.
  let childExited: Promise<number> | undefined;
  let killAgentGroup: ((signal: number | NodeJS.Signals) => void) | undefined;

  const spawnAgent = async (agentArgs: string[]): Promise<RpcAgentProcess> => {
    const argv = [...(opts.command ?? ompCommand()), ...agentArgs];
    const proc = Bun.spawn(argv, {
      cwd: opts.workdir,
      env: {
        ...process.env, ...(opts.env ?? {}), CLAUDE_CONFIG_DIR: emptyConfig,
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      detached: true,
    });

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
    // Exposed synchronously, before the pgid probe below ever yields: the
    // child is physically running the instant Bun.spawn returns, so a
    // dispose() landing in that gap must still be able to kill it.
    killAgentGroup = killGroup;

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

    // `detached: true` is only worth anything if it actually took effect. If
    // some platform or runtime combination silently ignored it, the group
    // kill above would throw ESRCH, its own catch would quietly fall back to
    // killing just the direct child, and the descendant-orphaning defect
    // this file exists to prevent would be back with no error and no failing
    // test. Confirm the agent really is its own process-group leader, and
    // refuse to run rather than pretend. A probe that could not RUN (no ps,
    // or the child already exited) is not evidence of failure and is only
    // noted — this must not invent a reason to fail a healthy run.
    const probe = await Bun.$`ps -o pgid= -p ${proc.pid}`.nothrow().quiet();
    const pgid = Number(probe.stdout.toString().trim());
    if (probe.exitCode !== 0 || !Number.isFinite(pgid)) {
      appendProgress(runDir, `NOTE could not verify the agent's process group for pid ${proc.pid}`);
    } else if (pgid !== proc.pid) {
      killGroup("SIGKILL");
      throw new Error(
        `omp agent pid ${proc.pid} is not its own process-group leader (pgid ${pgid}) — ` +
        `refusing to start, because teardown would then reach only the direct child and ` +
        `leave omp's bash tool calls running against ${opts.workdir}`,
      );
    }

    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      peekStderr: () => stderrTail,
      kill: (signal, graceMs) => {
        killGroup((signal as number | NodeJS.Signals | undefined) ?? "SIGTERM");
        if (graceMs !== undefined && graceMs >= 0) {
          // Escalate to the whole group, not gated on the leader's own
          // liveness — the leader can exit from SIGTERM while a descendant
          // that ignores it survives, and a leader-only check would then
          // never send the SIGKILL that descendant needs.
          const escalate = setTimeout(() => killGroup("SIGKILL"), graceMs);
          escalate.unref?.();
        }
      },
      exited,
    };
  };

  // The agent's own escape hatch when it is stuck. Its execute() returns a
  // promise this deliberately leaves unresolved, so omp's turn parks on the
  // tool call until answer() arrives — no frames, no polling. A native Claude
  // subagent has no equivalent.
  const asker = createAskSupervisor(ask => {
    result.ask = ask;
    result.state = "asking";
    writeResult(runDir, result);
    appendProgress(runDir, `ASK ${ask.question}`);
  });

  const client = new RpcClient({
    spawn: spawnAgent,
    provider, model: id,
    terminationGraceMs: TERMINATION_GRACE_MS,
    args: buildOmpArgs(opts),
    customTools: [asker.tool as never],
  });

  // Re-armable, not one-shot. A completed run can be resumed by say(), and a
  // resumed run needs its own settle promise — the original has already
  // resolved, so awaiting it again would hand back the PREVIOUS turn's result.
  let settled: (r: RunResult) => void;
  let done = new Promise<RunResult>(res => { settled = res; });
  // state.startedAt is re-armed per turn because it is what max_seconds is
  // measured against. result.seconds must NOT reset with it, so each settled
  // turn's duration is banked here; otherwise a resumed run would report only
  // its most recent turn.
  let bankedSeconds = 0;
  let finishing = false;
  let disposed = false;
  let statsFailures = 0;
  // Follow-ups queued by say() that have not yet had their turn. A terminal
  // agent_end must not settle the run as completed while one is outstanding,
  // or say() ends the very run it was trying to continue.
  let followUpsPending = 0;

  let unsubscribeEvents: (() => void) | undefined;
  let wallClock: ReturnType<typeof setTimeout> | undefined;
  let costPoll: ReturnType<typeof setInterval> | undefined;
  // The first-response watchdog's timer — see where it is armed, after the
  // prompt is submitted, for why it exists and what it must not fire on.
  let firstResponse: ReturnType<typeof setTimeout> | undefined;
  // Liveness bookkeeping: when the last session frame arrived, and whether
  // the first one has been logged. A frame is ANY event the agent emits —
  // thinking deltas included.
  let lastFrameAt = 0;
  let sawFirstFrame = false;

  /**
   * Named so a resumed run can arm a second poll after the first was cleared
   * in teardown. Reads its interval per call, like the wall clock, so a test
   * can shrink it without a module-load-time freeze.
   */
  let lastHeartbeatCost = 0;
  const armCostPoll = () => {
    const pollIntervalMs = Number(process.env.OMP_DISPATCH_POLL_MS) || 15_000;
    costPoll = setInterval(() => {
      if (finishing) return;
      void (async () => {
        const ok = await refreshStats();
        if (finishing || !ok) return;
        // A long single turn emits no agent_end, so the log goes quiet for
        // its whole duration. A cost heartbeat when the number has MOVED
        // (never a fixed-cadence line — a stuck agent must still look stuck)
        // is the difference between "working" and "hung"; last_frame backs it
        // with the stronger signal — age of the newest session frame, which
        // stays near zero while tokens stream even when no turn has landed.
        if (state.costUsd > lastHeartbeatCost + 1e-9) {
          appendProgress(runDir, `heartbeat turns=${state.turns} $${state.costUsd.toFixed(4)}` +
            ` last_frame=${Math.max(0, Math.round((Date.now() - lastFrameAt) / 1000))}s`);
          lastHeartbeatCost = state.costUsd;
        }
        const b = breach(state, caps);
        if (b) {
          appendProgress(runDir, `POLL breach detected mid-turn: ${b} ($${state.costUsd.toFixed(4)})`);
          await finish(b);
        }
      })();
    }, pollIntervalMs);
  };

  const finish = async (stopped: NonNullable<RunResult["stopped_because"]>) => {
    if (finishing) return;
    finishing = true;
    // The wall clock and poll are stopped immediately — nothing depends on
    // them firing again, and this is their only clearing site, so a second
    // route to clearing them cannot mask a poll created after teardown. The
    // session-event listener is deliberately NOT unsubscribed yet (see the
    // finally block): client.abort() below makes the fake (and real omp)
    // emit its own unsolicited agent_end, and the handler's own
    // `if (finishing) return` guard — checked against the flag just set
    // above — is what stops that frame from being double-counted as a turn.
    // Unsubscribing here instead would make that guard unreachable and this
    // exact regression untestable.
    clearTimeout(wallClock);
    clearInterval(costPoll);
    clearTimeout(firstResponse);

    let statsError: unknown;
    try {
      if (stopped !== "completed") await client.abort().catch(() => {});
      try {
        const s = await client.getSessionStats();
        result.cost_usd = s.cost;
        result.tool_calls = s.toolCalls;
        result.session_file = s.sessionFile ?? null;
        result.last_reply = await client.getLastAssistantText();
      } catch (e) {
        // Captured, not logged here — see the logging block at the end.
        // Every other failure in this file is logged; this one used to
        // swallow entirely, which can leave the spend figure a full turn
        // short with nothing in progress.log to say why. Deliberately NOT
        // escalated: the run has already settled by the time this runs, and
        // refreshStats()'s counter is the mechanism for stats failures that
        // still matter. This is about visibility only.
        statsError = e;
      }
      // Deliberately NO client.stop() here. Settling a run and releasing the
      // agent are now separate: the MCP server owns the process and calls
      // dispose() when it is done with the handle. stop()ping here would
      // also make stop() and dispose() the same operation.

      // From here on nothing may skip settled(result) or leave the workspace
      // locked: unlockPaths and gitChangedSince can both genuinely throw
      // (a chmod failure, or `git status` failing), so each gets its own
      // guard instead of one bare await that would abandon the rest of the
      // teardown — and, in the unlock case, leave paths unwritable forever.
      //
      // Every failure above is CAPTURED and logged at the end, after the
      // result has been assigned. Nothing in this function may log before
      // that assignment: appendProgress can itself throw on an unwritable
      // progress.log, and a throw between a failure and the assignment skips
      // the assignment, so `settled` resolves a FINISHED run still claiming
      // state:"running". That is this guard's own symptom reached by another
      // route, and ordering — not another wrapper — is what removes it.
      let unlockError: unknown;
      try {
        await unlockPaths(opts.workdir, readonly);
      } catch (e) {
        unlockError = e;
      }
      let gitError: unknown;
      let diff: { files: string[]; patch: string } | null = null;
      try {
        diff = await gitDiffSince(opts.workdir, before);
        result.files_changed = diff?.files ?? [];
      } catch (e) {
        gitError = e;
      }

      result.seconds = bankedSeconds + Math.round((Date.now() - state.startedAt) / 1000);
      result.turns = state.turns;
      // A failed unlock means the workspace may still be unwritable — a more
      // urgent fact than whatever originally stopped the run, so it overrides
      // the reported outcome instead of being buried in a log line only.
      const unlockFailed = unlockError !== undefined;
      result.stopped_because = unlockFailed ? "error" : stopped;
      result.state = unlockFailed ? "error" : (
        stopped === "completed" ? "completed"
        : stopped === "aborted" ? "aborted"
        : stopped === "error" || stopped === "no_response" ? "error"
        : stopped === "asking" ? "asking"
        : "capped");

      // The result is now true whatever happens next, so these can throw
      // freely. The one wrapper left is NOT protecting the result — that is
      // the ordering's job — it only stops a lost log line becoming an
      // unhandled rejection on the poll and wall-clock paths, which call
      // finish() with `void`.
      try {
        if (statsError !== undefined) {
          appendProgress(runDir, `ERROR the final get_session_stats failed — cost and last reply may be short: ${String(statsError)}`);
        }
        if (unlockError !== undefined) {
          appendProgress(runDir, `ERROR failed to unlock paths — workspace may still be read-only: ${String(unlockError)}`);
        }
        if (gitError !== undefined) {
          appendProgress(runDir, `ERROR failed to compute files_changed: ${String(gitError)}`);
        }
      } catch { /* a lost log line must not become an unhandled rejection */ }
      // The diff is the review surface a supervisor reads instead of running
      // git itself; a write failure must not lose the log lines above.
      if (diff?.patch) {
        try { writeDiff(runDir, diff.patch); } catch { /* best effort */ }
      }
    } finally {
      // settled(result) and a best-effort write/log must happen regardless of
      // what threw above — an unhandled throw here would leave `settled` (and
      // its caller) hanging forever with result.json stuck at state:"running".
      // Unsubscribe happens here, once, guaranteed — see the comment above
      // for why it isn't earlier.
      // A parked ask would otherwise hold the agent's turn open forever
      // against a run that has already settled.
      asker.cancelAll(`run ${runId} settled (${stopped}) while a question was waiting`);
      unsubscribeEvents?.();
      try { writeResult(runDir, result); } catch { /* best effort */ }
      try {
        appendProgress(runDir, `END ${result.stopped_because} — $${result.cost_usd.toFixed(4)}, ${result.turns} turns`);
      } catch { /* best effort */ }
      settled(result);
    }
  };

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

  const onSessionEvent = async (event: any) => {
    // rpc-client.ts:1117 calls this listener bare (no try/catch of its own),
    // so an uncaught throw anywhere below — even a plain fs error appending
    // to progress.log — would become an unhandled rejection: finish() would
    // never run, and the run would drift to the wall clock with the
    // workspace still locked. Route any such throw to the same teardown.
    try {

      // A raw dump of every RPC frame. OFF unless OMP_DISPATCH_TRACE is set, and
      // it exists for the tests that need to observe frames directly — that the
      // handler routes a throw to teardown, and that the listener really is
      // unsubscribed when a run settles. It is NOT a product feature and is not
      // documented as one: nothing reads it, it was ~85% of a run's disk
      // footprint when it was always-on, and telemetry from dispatched agents is
      // omp's business rather than this plugin's.
    if (process.env.OMP_DISPATCH_TRACE) {
      appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    }

    const ev = event.assistantMessageEvent;
      // ANY frame from the agent — a thinking delta, a tool call starting,
      // any agent_end — is provider liveness, and the first-response watchdog
      // armed below has done its one job. 0.3.1 cleared only on tool_start /
      // agent_end, which killed healthy runs: deepseek-v4-pro routinely
      // reasons for four-plus minutes before its first tool call on a real
      // brief, streaming frames the whole time (see the sif runs of
      // 2026-09-14, both executing at $0.03 mid-reasoning). A true wedge —
      // the deepseek-flash outage — emits NOTHING, which is exactly what the
      // watchdog remains for.
      if (!finishing) {
        lastFrameAt = Date.now();
        if (!sawFirstFrame) {
          sawFirstFrame = true;
          appendProgress(runDir, `FIRST FRAME ${ev?.type ?? event.type} — provider responding`);
        }
        clearTimeout(firstResponse);
      }
      if (ev?.type === "tool_start") {
        appendProgress(runDir, `${ev.name} ${String(JSON.stringify(ev.input ?? "")).slice(0, 70)}`);
      }

      // Once a settle is under way, no more progress-log lines or turn
      // accounting — a stray frame from the abort finish() just issued
      // (still logged above, for the audit trail) must not log a tool_start
      // or double-count a turn after the END line has already been written.
      // This is deliberately checked here, before unsubscribing (which
      // happens later, in finish()'s finally) — see the comment there.
      if (finishing) return;

      if (event.type !== "agent_end") return;
      if (!countTurn(state, event)) return;    // isTerminal:false is not a turn

      const ok = await refreshStats();
      if (finishing) return;                   // refreshStats() may have already ended the run
      result.turns = state.turns;
      writeResult(runDir, result);
      appendProgress(runDir, `turn ${state.turns} — $${state.costUsd.toFixed(4)}`);
      if (!ok) return;

      const b = breach(state, caps);
      if (b) {
        await finish(b);
        return;
      }
      // A cap always wins over a pending follow-up; short of one, a turn
      // that a say() is still waiting behind must not settle the run.
      if (followUpsPending > 0) {
        followUpsPending -= 1;
        return;
      }
      await finish("completed");
    } catch (e) {
      if (!finishing) {
        appendProgress(runDir, `ERROR the session-event handler threw: ${String(e)}`);
        await finish("error").catch(() => {});
      }
    }
  };

  unsubscribeEvents = client.onSessionEvent(onSessionEvent);

  wallClock = setTimeout(() => void finish("max_seconds"), opts.maxSeconds * 1000);

  try {
    await client.start();

    // The wall clock can fire while start() above is still pending —
    // finish() has then already run its cleanup by the time start() settles,
    // finding costPoll (and everything below) not created yet. Nothing past
    // this point may still run in that case: creating the poll anyway would
    // leak an interval nothing will ever clear, and calling
    // getState()/prompt() would restart work on a client finish() has
    // already torn down.
    if (!finishing) {
      // The real hook for "did the child die unexpectedly": spawnAgent
      // above captured the same `exited` promise a caller-owned process
      // would have. dispose() itself kills the child, but by then
      // `finishing` is already true, so this is a no-op on that path.
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
      armCostPoll();

      const st = await client.getState();
      result.model = st.model ? { provider: st.model.provider, id: st.model.id } : null;
      result.session_file = st.sessionFile ?? null;
      writeResult(runDir, result);
      appendProgress(runDir, `START ${opts.model}`);
      await client.prompt(opts.prompt);
      // The gap between START and the first tool_start is exactly where a
      // supervisor's first poll used to land and see nothing but "running".
      // This line says the brief is in flight, not still connecting.
      appendProgress(runDir, `PROMPT submitted (${opts.prompt.length} chars)`);
      lastFrameAt = Date.now();

      // First-response watchdog, armed the moment the brief is in flight. A
      // provider hang looks like this from here: the prompt was accepted,
      // then nothing — zero turns, zero tool calls, $0 — while omp's own RPC
      // channel stays healthy, so the stats poll keeps succeeding and nothing
      // else notices; the run drifts to the max_seconds wall clock (twenty
      // minutes of silent dead air on the default caps). Seen in the wild as
      // an intermittent deepseek-flash failure. Deliberately bounds only the
      // FIRST response: an agent that has answered once is bounded by the
      // turn/budget/time caps, and a pending supervisor question is a wait on
      // us, not the provider. Read per run, like OMP_DISPATCH_POLL_MS, so a
      // test can shrink it without a module-load-time freeze.
      const deadAirMs = Number(process.env.OMP_DISPATCH_DEAD_AIR_MS) || 240_000;
      firstResponse = setTimeout(() => {
        if (finishing) return;
        appendProgress(
          runDir,
          `ERROR no model response within ${Math.round(deadAirMs / 1000)}s of the prompt — ` +
          `provider hang suspected (zero turns, zero tool calls). ` +
          `Stopping instead of burning the time cap; retry, or dispatch on a different tier.`,
        );
        void finish("no_response");
      }, deadAirMs);
    }
  } catch (e) {
    if (!finishing) {
      appendProgress(runDir, `ERROR ${String(e)}`);
      await finish("error");
    }
  }

  // Anything that talks to the agent needs the agent to still be there and
  // the run to still be open. Failing loudly beats the two alternatives:
  // hanging on a turn that will never come, or answering from a session the
  // run has already reported on. Resuming a SETTLED run — which is what a
  // conversation across separate dispatches needs — is deliberately not
  // implemented here: it turns on decisions this task has no ruling for
  // (whether a resumed run re-arms the wall clock, how cumulative caps apply
  // across an idle gap), and guessing at them belongs nowhere near this file.
  const assertUsable = (what: string) => {
    if (disposed) {
      throw new Error(`run ${runId}: ${what}() after dispose() — the omp process is gone`);
    }
    if (finishing) {
      throw new Error(
        `run ${runId}: ${what}() on a run that has already settled ` +
        `(${result.stopped_because}) — resuming a settled run is not supported`,
      );
    }
  };

  /**
   * Re-open a run that settled as `completed`, so a later say() continues the
   * same agent — parity with a native subagent, where SendMessage resumes a
   * finished agent from its transcript.
   *
   * Only `completed` qualifies. A capped run must not be resumable or the cap
   * means nothing; an aborted or errored one has nothing coherent to continue.
   *
   * The wall clock re-arms for the new turn while turns and cost keep
   * accumulating — they come from getSessionStats() and are cumulative by
   * nature, so a resumed run cannot spend its way past max_usd one turn at a
   * time. Seconds are banked so they accumulate too.
   */
  const rearm = () => {
    if (disposed) {
      throw new Error(`run ${runId}: say() after dispose() — the omp process is gone`);
    }
    if (result.stopped_because !== "completed") {
      throw new Error(
        `run ${runId}: cannot resume a run that stopped because ${result.stopped_because} — ` +
        `only a completed run can be continued`,
      );
    }
    const b = breach(state, caps);
    if (b) {
      throw new Error(
        `run ${runId}: resuming would immediately breach ${b} ` +
        `($${state.costUsd.toFixed(4)}, ${state.turns} turns) — start a new run instead`,
      );
    }
    bankedSeconds = result.seconds;
    state.startedAt = Date.now();
    finishing = false;
    result.state = "running";
    result.stopped_because = null;
    done = new Promise<RunResult>(res => { settled = res; });
    writeResult(runDir, result);
    appendProgress(runDir, `RESUME turn ${state.turns + 1}`);
    // Teardown unsubscribed the listener (deliberately — it is what makes the
    // double-count guard reachable). Without re-subscribing, the resumed
    // turn's agent_end has nobody listening and the run never settles.
    unsubscribeEvents = client.onSessionEvent(onSessionEvent);
    wallClock = setTimeout(() => void finish("max_seconds"), opts.maxSeconds * 1000);
    armCostPoll();
  };

  return {
    runId,
    runDir,
    result,
    // A getter, not a captured value: a resumed run installs a NEW settle
    // promise, and a caller holding the old one would wait forever.
    get settled() { return done; },
    say: async (text: string): Promise<string> => {
      // A settled-but-completed run is resumable — that is what a conversation
      // spanning separate dispatches needs, and what native SendMessage does.
      // rearm() throws for every other settled state.
      const resumed = finishing;
      if (resumed) rearm();
      else assertUsable("say");

      // followUpsPending exists so a turn finishing mid-run does not settle
      // the run out from under a queued follow-up — another agent_end is
      // still coming for that follow-up's own turn. On a RESUMED run there is
      // no turn in flight: this follow-up IS the turn, and its agent_end is
      // the one that must settle. Incrementing here would make the handler
      // swallow that frame and wait forever for a second one that never comes.
      if (!resumed) followUpsPending += 1;
      try {
        await client.followUp(text);
      } catch (e) {
        if (!resumed) followUpsPending -= 1;   // never leave a phantom follow-up holding the run open
        throw e;
      }
      // A cap firing while this is outstanding settles the run and releases
      // this wait too — no separate waiter to leak.
      return (await done).last_reply ?? "";
    },
    steer: async (text: string): Promise<void> => {
      assertUsable("steer");
      await client.steer(text);
    },
    stop: async (): Promise<void> => {
      await finish("aborted");
    },
    answer: (askId: string, text: string): boolean => {
      const ok = asker.answer(askId, text);
      if (ok) {
        result.ask = null;
        result.state = "running";
        writeResult(runDir, result);
        appendProgress(runDir, `ANSWERED ${askId}`);
      }
      return ok;
    },
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      // Settle first so the workspace is unlocked and a result is written
      // even when the caller disposes a run that was still going.
      await finish("aborted");
      // finish() returns IMMEDIATELY when a settle is already in flight, so
      // awaiting it is not enough on its own: that other teardown may still
      // be mid-`getSessionStats()`. Killing the tree underneath it makes the
      // pending request reject, and the run then reports a short cost_usd
      // and a null last_reply. Wait for the settle itself, not just for the
      // call that may have been a no-op.
      await done;
      // client.stop() routes through the kill() above, so it is the group —
      // omp AND its bash tool calls — that gets the SIGTERM, and it waits
      // for the leader to exit. It is a no-op when start() never got as far
      // as a live process, which is exactly when the explicit kill below is
      // the only thing that reaps the child.
      await client.stop().catch(() => {});
      killAgentGroup?.("SIGKILL");
    },
  };
}
