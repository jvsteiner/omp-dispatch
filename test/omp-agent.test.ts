import { test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";
import { createRegistry } from "../src/mcp/runs.ts";
import { startRun } from "../src/runner.ts";
import { newRunId, createRunDir } from "../src/rundir.ts";

const FAKE_OMP = join(import.meta.dir, "fake-omp.ts");
const FAKE_COMMAND = ["bun", FAKE_OMP];
const MISSING_COMMAND = ["bun", "/definitely/does/not/exist.ts"];

const openClients: Client[] = [];

// `command` is passed straight to createServer(), which forwards it to every
// dispatch's RunOptions — the real seam runner.ts already documents, not an
// env var. Defaults to the fake so a test has to opt IN to a real (or
// deliberately broken) command rather than opt out of one.
async function connect(command: string[] = FAKE_COMMAND): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([createServer({ command }).connect(a), client.connect(b)]);
  openClients.push(client);
  return client;
}

// Isolate every test from the real machine's ~/.omp-dispatch/config.json and
// shell rc files. Neither exists on this box today, but a hermetic test must
// not depend on that staying true — see test/mcp-server.test.ts for the same
// pattern applied to omp_models.
let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-agent-fakehome-"));
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

afterEach(async () => {
  await Promise.all(openClients.splice(0).map(c => c.close()));
  delete process.env.FAKE_OMP_SCRIPT;
  delete process.env.FAKE_OMP_DUMP;
  delete process.env.OMP_DISPATCH_POLL_MS;
  delete process.env.OMP_DISPATCH_PROGRESS_MS;
});

function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "omp-agent-workdir-"));
}

// Configures test/fake-omp.ts's own scripted behaviour for whichever process
// connect()'s `command` points a dispatch at. No test in this file may
// contact a real model provider.
function scriptEnv(script: object): void {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify(script);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

test("a dispatch returns the agent's final reply", async () => {
  const workdir = tmpWorkdir();
  scriptEnv({ replies: ["all done, here is the report"] });
  const client = await connect();
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "explore code", prompt: "look around", workdir },
  });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("all done, here is the report");
}, 30_000);

test("the footer carries turns, cost, tool calls and stop reason", async () => {
  const workdir = tmpWorkdir();
  scriptEnv({ turnCostUsd: 0.05, toolCallsPerTurn: 4, replies: ["ok"] });
  const client = await connect();
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "count things", prompt: "count", workdir },
  });
  expect(r.isError).toBeFalsy();
  const text: string = r.content[0].text;
  expect(text).toContain("turns=1");
  expect(text).toContain("tool_calls=4");
  expect(text).toContain("cost_usd=0.0500");
  expect(text).toContain("stopped_because=completed");
  // model= comes from RunResult.model, which the fake always reports as
  // fake/fake-1 regardless of what was requested (see fake-omp.ts's
  // get_state handler) — a deterministic literal, not the implementation's
  // own constant.
  expect(text).toContain("model=fake/fake-1");
  expect(text).toMatch(/seconds=\d+/);
}, 30_000);

test("a cap breach is reported in the footer, not thrown", async () => {
  const workdir = tmpWorkdir();
  // omp_agent's own default max_usd cap is $1.00 (AGENT_DEFAULTS in
  // src/mcp/server.ts); a single $5 turn breaches it immediately without any
  // override needed.
  scriptEnv({ turnCostUsd: 5.0 });
  const client = await connect();
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "spend a lot", prompt: "go", workdir },
  });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("stopped_because=max_usd");
}, 30_000);

test("the model parameter's description advertises raw model ids", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const agentTool = tools.find(t => t.name === "omp_agent");
  expect(agentTool).toBeDefined();
  const modelProp: any = (agentTool!.inputSchema as any).properties?.model;
  expect(modelProp?.description).toContain("deepseek/deepseek-v4-pro");
  expect(modelProp?.description).toContain("omp_models");
});

test("an explicit model is passed through verbatim, not treated as a tier", async () => {
  const workdir = tmpWorkdir();
  const dumpDir = mkdtempSync(join(tmpdir(), "omp-agent-dump-"));
  const dump = join(dumpDir, "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  scriptEnv({});
  const client = await connect();
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: {
      description: "pin a model", prompt: "go", workdir, model: "deepseek/deepseek-v4-pro",
    },
  });
  expect(r.isError).toBeFalsy();
  const launched = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  const providerIdx = launched.argv.indexOf("--provider");
  const modelIdx = launched.argv.indexOf("--model");
  expect(providerIdx).toBeGreaterThanOrEqual(0);
  expect(launched.argv[providerIdx + 1]).toBe("deepseek");
  expect(modelIdx).toBeGreaterThanOrEqual(0);
  expect(launched.argv[modelIdx + 1]).toBe("deepseek-v4-pro");
}, 30_000);

test("two concurrent dispatches get distinct names", async () => {
  const workdir = tmpWorkdir();
  scriptEnv({});
  const client = await connect();
  const [a, b]: any[] = await Promise.all([
    client.callTool({
      name: "omp_agent", arguments: { description: "same task", prompt: "go", workdir },
    }),
    client.callTool({
      name: "omp_agent", arguments: { description: "same task", prompt: "go", workdir },
    }),
  ]);
  expect(a.isError).toBeFalsy();
  expect(b.isError).toBeFalsy();
  const nameOf = (r: any): string | undefined => /\[omp:([^\]]+)\]/.exec(r.content[0].text)?.[1];
  const nameA = nameOf(a);
  const nameB = nameOf(b);
  expect(nameA).toBeTruthy();
  expect(nameB).toBeTruthy();
  expect(nameA).not.toBe(nameB);
}, 30_000);

test("a duplicate explicit name is rejected naming the clash", async () => {
  const workdir = tmpWorkdir();
  scriptEnv({});
  const client = await connect();

  const first: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "first", prompt: "go", workdir, name: "shared-name" },
  });
  expect(first.isError).toBeFalsy();

  const second: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "second", prompt: "go", workdir, name: "shared-name" },
  });
  expect(second.isError).toBe(true);
  expect(second.content[0].text).toContain("shared-name");
}, 30_000);

test("a run that fails to start is an error, not a footer", async () => {
  const workdir = tmpWorkdir();
  const client = await connect(MISSING_COMMAND);
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "will fail", prompt: "go", workdir },
  });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).not.toContain("stopped_because=");
}, 30_000);

// The fifth vacuous-test finding in this build: the registry-level disposeAll
// test below proves the registry mechanism works, but never exercises
// omp_agent's OWN drop path — a handle it decides NOT to keep (the error
// branch in src/mcp/server.ts) — which is what requirement 1 is actually
// about. This drives that path through the real tool call. statsFailAfter:0
// fails every get_session_stats call from the first one; combined with a
// fast poll, the run reaches state "error" (three consecutive failures)
// well before any turn-cap or wall-clock would matter.
//
// Verified by mutation: deleting `await handle.dispose();` from the error
// branch in src/mcp/server.ts leaves the grandchild alive after the call
// settles; restoring it, the pid is gone. See the report for the dump/rerun.
test("omp_agent disposes a run it does not keep in the registry, killing its whole process tree", async () => {
  const workdir = tmpWorkdir();
  process.env.OMP_DISPATCH_POLL_MS = "50";
  scriptEnv({ spawnGrandchild: true, statsFailAfter: 0 });
  const client = await connect();

  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: { description: "will error out", prompt: "go", workdir },
  });
  expect(r.isError).toBe(true);

  const pidFile = join(workdir, "grandchild.pid");
  await waitForFile(pidFile);
  const gcPid = Number(readFileSync(pidFile, "utf8").trim());

  const deadline = Date.now() + 3000;
  while (isAlive(gcPid) && Date.now() < deadline) {
    await new Promise(r2 => setTimeout(r2, 20));
  }
  expect(isAlive(gcPid)).toBe(false);
}, 30_000);

// MCP's default request timeout is 60s (DEFAULT_REQUEST_TIMEOUT_MSEC); a real
// subagent dispatch can run for many minutes. omp_agent keeps a client's own
// timeout from firing by sending progress notifications, but only a client
// that actually asks for them (resetTimeoutOnProgress + a progressToken,
// supplied here via the SDK's own `onprogress` option) benefits — this drives
// a real MCP Client end to end, not a mock, with a deliberately short timeout
// the fake's own turn duration would otherwise blow through.
test("a long-running dispatch survives the calling client's own request timeout via progress notifications", async () => {
  const workdir = tmpWorkdir();
  process.env.OMP_DISPATCH_PROGRESS_MS = "40";
  scriptEnv({ turnDelayMs: 400 });
  const client = await connect();

  const r: any = await client.callTool(
    { name: "omp_agent", arguments: { description: "slow task", prompt: "go", workdir } },
    undefined,
    { timeout: 150, resetTimeoutOnProgress: true, onprogress: () => {} },
  );
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("stopped_because=completed");
}, 30_000);

// Assert it the way Task 3 asserted teardown: a real grandchild pid, not the
// registry being empty (which proves nothing about whether the process
// actually died). This drives src/mcp/runs.ts directly rather than through
// the omp_agent tool, since disposeAll() is its own registry-level contract.
test("disposeAll settles and disposes every registered run", async () => {
  const registry = createRegistry();
  const workdir = tmpWorkdir();
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ spawnGrandchild: true, turnDelayMs: 300 });

  const runId = newRunId();
  const runDir = createRunDir(workdir, runId);
  const handle = await startRun(
    {
      prompt: "go", model: "fake/fake-1", workdir, tools: "read",
      maxTurns: 120, maxUsd: 1.0, maxSeconds: 300,
      command: ["bun", FAKE_OMP],
    },
    runDir, runId,
  );
  registry.add("leaky", handle);

  const pidFile = join(workdir, "grandchild.pid");
  await waitForFile(pidFile);
  const gcPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(isAlive(gcPid)).toBe(true);   // sanity: the descendant actually started

  await handle.settled;               // let it settle before disposeAll runs

  await registry.disposeAll();

  const deadline = Date.now() + 3000;
  while (isAlive(gcPid) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  expect(isAlive(gcPid)).toBe(false);
  expect(registry.list()).toEqual([]);
}, 30_000);
