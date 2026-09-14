import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

/**
 * Durability: the in-memory registry dies with the server, result.json does
 * not. After a restart a supervisor must still see settled runs, read their
 * reports, and continue a COMPLETED one — its omp conversation resumed into
 * a fresh process with context intact. Only in-flight runs are lost.
 */
const clients: Client[] = [];
let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-durable-home-"));
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  delete process.env.FAKE_OMP_SCRIPT;
  delete process.env.FAKE_OMP_DUMP;
});

async function connect() {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "durability-test", version: "0" }, { capabilities: {} });
  await Promise.all([
    createServer({ command: ["bun", join(import.meta.dir, "fake-omp.ts")] }).connect(a),
    client.connect(b),
  ]);
  clients.push(client);
  return client;
}

const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<any>;

test("a settled run survives a restart: listed, readable, and continuable by resume", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-durable-w-"));

  // Session 1: dispatch and settle.
  const first = await connect();
  await call(first, "omp_agent", {
    description: "seed run", prompt: "remember banana", name: "durable",
    workdir, run_in_background: true,
  });
  const settled: any = await call(first, "omp_task_output", { name: "durable", wait_seconds: 10 });
  expect(JSON.stringify(settled.content)).toContain("stopped_because=completed");
  await first.close();

  // Session 2: fresh server, fresh registry — the run exists only on disk.
  const second = await connect();
  const listed: any = await call(second, "omp_list_agents");
  const listText = listed.content[0].text as string;
  expect(listText).toContain("durable");
  expect(listText).toContain("(on-disk)");

  const report: any = await call(second, "omp_task_output", { name: "durable" });
  const reportText = report.content[0].text as string;
  expect(reportText).toContain("(on-disk run");
  expect(reportText).toContain("stopped_because=completed");

  // Resume requires the workdir, and says so.
  const noWorkdir: any = await call(second, "omp_send_message", {
    to: "durable", message: "what was the word?", run_in_background: true,
  });
  expect(noWorkdir.isError).toBe(true);
  expect(JSON.stringify(noWorkdir.content)).toContain("requires its workdir");

  // Resume with it: a fresh agent process continues the conversation.
  const dump = join(mkdtempSync(join(tmpdir(), "omp-durable-dump-")), "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  const resumed: any = await call(second, "omp_send_message", {
    to: "durable", message: "what was the word?", workdir, run_in_background: true,
  });
  expect(resumed.isError).toBeFalsy();
  expect(resumed.content[0].text).toContain("Resumed 'durable'");
  const collected: any = await call(second, "omp_task_output", { name: "durable", wait_seconds: 10 });
  const collectedText = JSON.stringify(collected.content);
  expect(collectedText).toContain("stopped_because=completed");

  // The child was launched resuming the recorded session file.
  const argv = readFileSync(dump, "utf8");
  expect(argv).toContain("--resume=/tmp/fake-session.jsonl");
  // And the run directory records the continuation.
  const runRoot = join(process.env.HOME!, ".omp-dispatch", "runs");
  const log = progressLogFor(runRoot, "durable");
  expect(log).toContain("resuming a saved conversation");
}, 30_000);

function progressLogFor(runRoot: string, name: string): string {
  if (!existsSync(runRoot)) return "";
  for (const project of readdirSync(runRoot)) {
    for (const id of readdirSync(join(runRoot, project))) {
      const dir = join(runRoot, project, id);
      const result = join(dir, "result.json");
      const log = join(dir, "progress.log");
      if (existsSync(result) && existsSync(log) &&
          JSON.parse(readFileSync(result, "utf8")).name === name) {
        return readFileSync(log, "utf8");
      }
    }
  }
  return "";
}

test("a non-completed on-disk run refuses to resume, naming why", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-durable-w2-"));
  const first = await connect();
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnCostUsd: 5.0 });
  await call(first, "omp_agent", {
    description: "capped run", prompt: "go", name: "capped-run",
    workdir, run_in_background: true,
  });

  await call(first, "omp_task_output", { name: "capped-run", wait_seconds: 10 });
  await first.close();

  const second = await connect();
  const refused: any = await call(second, "omp_send_message", {
    to: "capped-run", message: "continue", workdir, run_in_background: true,
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("max_usd");
}, 30_000);

test("a run that was in flight when the server died reads as stale, not live", async () => {
  // Forge the on-disk shape a killed server leaves behind.
  const runRoot = join(process.env.HOME!, ".omp-dispatch", "runs");
  const projectDir = join(runRoot, `stale-proj-${Date.now()}`);
  const runDir = join(projectDir, "20260915T000000Z-000000stale1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "result.json"), JSON.stringify({
    run_id: "20260915T000000Z-000000stale1", name: "stale-run", state: "running",
    stopped_because: null, turns: 2, tool_calls: 4, cost_usd: 0.02, seconds: 90,
    model: { provider: "deepseek", id: "deepseek-v4-pro" }, session_file: "/tmp/x.jsonl",
    files_changed: [], last_reply: null, ask: null,
  }));

  const client = await connect();
  const out: any = await call(client, "omp_task_output", { name: "stale-run" });
  const text = out.content[0].text as string;
  expect(text).toContain("in flight when its server went away");
}, 30_000);

function findProgressLog(runRoot: string, name: string): string {
  const { readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
  if (!existsSync(runRoot)) return "";
  for (const project of readdirSync(runRoot)) {
    for (const id of readdirSync(join(runRoot, project))) {
      const log = join(runRoot, project, id, "progress.log");
      if (!existsSync(log)) continue;
      const text = readFileSync(log, "utf8");
      if (text.includes(`ASK `) && false) continue;
      // The durable run's directory is the one whose result.json carries the name.
      const result = join(runRoot, project, id, "result.json");
      if (existsSync(result) && JSON.parse(readFileSync(result, "utf8")).name === name) {
        return text;
      }
    }
  }
  return "";
}
