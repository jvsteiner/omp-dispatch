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
