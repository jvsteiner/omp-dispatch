#!/usr/bin/env bun
/**
 * A stand-in for `omp --mode rpc`. Speaks enough of the protocol for the
 * broker to be tested with no provider, no network and no money.
 *
 * FAKE_OMP_SCRIPT is JSON:
 *   { turnCostUsd, toolCallsPerTurn, replies: string[],
 *     nonTerminalFirst: boolean, askOnTurn: number | null,
 *     turnDelayMs: number, crashAfterPrompt: boolean, readyDelayMs: number,
 *     hangAfterPrompt: boolean, spawnGrandchild: boolean, statsFailAfter: number | null }
 *
 * FAKE_OMP_DUMP, when set, names a path this process writes its own argv,
 * cwd and CLAUDE_CONFIG_DIR to, so a test can assert what the host actually
 * launched omp with — including env, not just argv.
 */
import { writeFileSync } from "node:fs";

const script = JSON.parse(process.env.FAKE_OMP_SCRIPT ?? "{}");
const turnCostUsd: number = script.turnCostUsd ?? 0.01;
const toolCallsPerTurn: number = script.toolCallsPerTurn ?? 2;
const replies: string[] = script.replies ?? ["done"];
const nonTerminalFirst: boolean = script.nonTerminalFirst ?? false;
const askOnTurn: number | null = script.askOnTurn ?? null;
// Keeps a turn "in flight" (cost already incurred, no terminal frame yet)
// long enough for something else — a host's periodic budget poll — to
// observe it before agent_end arrives.
const turnDelayMs: number = script.turnDelayMs ?? 0;
// Simulates omp dying mid-turn (e.g. an OOM kill): the prompt is acked, then
// the process exits before ever reporting agent_end.
const crashAfterPrompt: boolean = script.crashAfterPrompt ?? false;
// Simulates a provider hang: the prompt is acked and this process stays
// alive — RPC keeps answering (get_session_stats included), exactly like a
// real omp whose provider call wedged — but no agent_end ever comes.
const hangAfterPrompt: boolean = script.hangAfterPrompt ?? false;
// Delays the initial ready frame, so a test can act (e.g. send a signal)
// while a host's client.start() is still genuinely pending.
const readyDelayMs: number = script.readyDelayMs ?? 0;
// Stands in for a bash tool call: a real descendant process, not a fake
// frame. Its pid is written to grandchild.pid in this process's cwd (the
// task workdir) so a test can check it's actually gone after teardown.
const spawnGrandchild: boolean = script.spawnGrandchild ?? false;
// Answers this many get_session_stats calls and fails every one after,
// WITHOUT dying, so a host's consecutive-stats-failure escalation can be
// exercised on its own. A fake that crashed instead would end the run by the
// separate child-exited route and prove nothing about the escalation.
const statsFailAfter: number | null = script.statsFailAfter ?? null;

interface RpcCommand {
  id?: string;
  type: string;
  protocolVersion?: number;
  tools?: Array<{ name: string }>;
}

let turns = 0;
let cost = 0;
let toolCalls = 0;
let hostTools: Array<{ name: string }> = [];
let statsCalls = 0;

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (readyDelayMs > 0) await Bun.sleep(readyDelayMs);
out({
  type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
});

// Bun.argv is [bun, thisScript, ...the args the host appended]; the slice is
// what the host itself chose to pass.
if (process.env.FAKE_OMP_DUMP) {
  writeFileSync(process.env.FAKE_OMP_DUMP, JSON.stringify({
    argv: Bun.argv.slice(2), cwd: process.cwd(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  }));
}

if (spawnGrandchild) {
  const gc = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  writeFileSync("grandchild.pid", String(gc.pid));
}

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

  if (turnDelayMs > 0) await Bun.sleep(turnDelayMs);

  if (nonTerminalFirst && turns === 1) {
    out({ type: "agent_end", messages: [], isTerminal: false });   // must NOT count
  }
  out({ type: "agent_end", messages: [], isTerminal: true });
}

for await (const line of console) {
  if (!line.trim()) continue;
  let cmd: RpcCommand;
  try { cmd = JSON.parse(line) as RpcCommand; } catch {
    out({ type: "response", command: "parse", success: false, error: "bad json" });
    continue;
  }
  const ok = (data?: unknown) =>
    out({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
  const fail = (error: string) =>
    out({ id: cmd.id, type: "response", command: cmd.type, success: false, error });

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
    case "get_session_stats":
      statsCalls += 1;
      if (statsFailAfter !== null && statsCalls > statsFailAfter) {
        fail(`get_session_stats: scripted failure (call ${statsCalls})`);
        break;
      }
      ok(stats());
      break;
    case "get_last_assistant_text": ok({ text: replies[Math.min(turns, replies.length) - 1] ?? "done" }); break;
    case "host_tool_result":
      ok();
      cost += turnCostUsd;
      out({ type: "agent_end", messages: [], isTerminal: true });
      break;
    case "prompt": case "follow_up": case "steer":
      ok({ agentInvoked: true });
      if (crashAfterPrompt) { setTimeout(() => process.exit(1), 20); break; }
      if (hangAfterPrompt) break;
      void runTurn();
      break;
    case "abort":
      ok();
      out({ type: "agent_end", messages: [], isTerminal: true });
      break;
    default:
      console.error(`fake-omp: unimplemented command "${cmd.type}"`);
      fail(`unimplemented command: ${cmd.type}`);
  }
}
