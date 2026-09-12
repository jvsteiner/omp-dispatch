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
    // finish() itself calls client.abort(), which makes the fake (and real
    // omp) emit a second, unsolicited agent_end. That frame is still logged
    // above for the audit trail, but it must not re-enter turn accounting:
    // finish() already captured state.turns for the result, and a second
    // countTurn() here would race finish()'s own reads of `state` and could
    // overwrite the just-written result with a bogus extra turn.
    if (finishing) return;
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
