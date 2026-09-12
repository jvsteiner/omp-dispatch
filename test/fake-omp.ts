#!/usr/bin/env bun
/**
 * A stand-in for `omp --mode rpc`. Speaks enough of the protocol for the
 * broker to be tested with no provider, no network and no money.
 *
 * FAKE_OMP_SCRIPT is JSON:
 *   { turnCostUsd, toolCallsPerTurn, replies: string[],
 *     nonTerminalFirst: boolean, askOnTurn: number | null }
 */
export {}; // top-level for-await below needs this file to be a module

const script = JSON.parse(process.env.FAKE_OMP_SCRIPT ?? "{}");
const turnCostUsd: number = script.turnCostUsd ?? 0.01;
const toolCallsPerTurn: number = script.toolCallsPerTurn ?? 2;
const replies: string[] = script.replies ?? ["done"];
const nonTerminalFirst: boolean = script.nonTerminalFirst ?? false;
const askOnTurn: number | null = script.askOnTurn ?? null;

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
  let cmd: RpcCommand;
  try { cmd = JSON.parse(line) as RpcCommand; } catch {
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
