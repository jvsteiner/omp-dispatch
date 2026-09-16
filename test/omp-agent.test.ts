import { test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/mcp/server.ts";
import { createRegistry, uniqueName } from "../src/mcp/runs.ts";
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

test("the model parameter is the palette enum, not an open string", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const agentTool = tools.find(t => t.name === "omp_agent");
  expect(agentTool).toBeDefined();
  // Boundary data from the SDK: validate once, then read typed values.
  const ModelProp = z.object({ enum: z.array(z.string()), description: z.string() });
  const modelProp = z.object({ properties: z.object({ model: ModelProp }).optional() })
    .parse(agentTool!.inputSchema).properties?.model;
  // Exactly the native vocabularies of both hosts — a constrained choice is
  // the point: the caller keeps its pick-by-job reflex and has no vendor
  // catalogue or price list to deliberate over.
  expect(modelProp?.enum).toContain("haiku");
  expect(modelProp?.enum).toContain("sonnet");
  expect(modelProp?.enum).toContain("opus");
  expect(modelProp?.enum).toContain("fable");
  expect(modelProp?.enum).toContain("gpt-5.6-luna");
  expect(modelProp?.enum).toContain("gpt-5.6-terra");
  expect(modelProp?.enum).toContain("gpt-6-astra");
  expect(modelProp?.description).toContain("default tier");
  expect(modelProp?.description).not.toContain("omp_models");
  // The server's first start is a fresh install's first moment: the editable
  // config comes into being here, with the shipped palette.
  expect(existsSync(join(process.env.HOME!, ".omp-dispatch", "config.json"))).toBe(true);
});

test("a palette tier resolves to the configured model in the child argv", async () => {
  const workdir = tmpWorkdir();
  const dumpDir = mkdtempSync(join(tmpdir(), "omp-agent-dump-"));
  const dump = join(dumpDir, "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  scriptEnv({});
  const client = await connect();
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: {
      description: "pick a tier", prompt: "go", workdir, model: "gpt-5.6-luna",
    },
  });
  expect(r.isError).toBeFalsy();
  const launched = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  const providerIdx = launched.argv.indexOf("--provider");
  const modelIdx = launched.argv.indexOf("--model");
  expect(providerIdx).toBeGreaterThanOrEqual(0);
  expect(launched.argv[providerIdx + 1]).toBe("deepseek");
  expect(modelIdx).toBeGreaterThanOrEqual(0);
  // Codex's habitual id is a tier name here; the user's mapping decides the model.
  expect(launched.argv[modelIdx + 1]).toBe("deepseek-flash");
}, 30_000);

test("a raw model id is refused by the schema before anything runs", async () => {
  const client = await connect();
  // The SDK converts schema violations into an isError result, not a throw.
  const r: any = await client.callTool({
    name: "omp_agent",
    arguments: {
      description: "raw id", prompt: "go", workdir: tmpWorkdir(),
      model: "openai/gpt-5.5-pro",
    },
  });
  expect(r.isError).toBe(true);
  // The refusal teaches the palette, so the caller's retry needs no guessing.
  expect(JSON.stringify(r.content)).toContain("Invalid enum value");
  expect(JSON.stringify(r.content)).toContain("gpt-6-astra");
}, 30_000);

test("two concurrent dispatches get distinct names", async () => {
  // Distinct workdirs: one shared workdir holds one in-flight run now, and
  // name uniqueness is this test's subject, not workdir contention.
  const workdirA = tmpWorkdir();
  const workdirB = tmpWorkdir();
  scriptEnv({});
  const client = await connect();
  const [a, b]: any[] = await Promise.all([
    client.callTool({
      name: "omp_agent", arguments: { description: "same task", prompt: "go", workdir: workdirA },
    }),
    client.callTool({
      name: "omp_agent", arguments: { description: "same task", prompt: "go", workdir: workdirB },
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

// Claude Code's own per-call wall clock (MCP_TOOL_TIMEOUT) is generous
// enough (~28h) that a real dispatch is never at risk from it, and
// MCP_TIMEOUT's 30s only bounds server startup, not a call in flight — the
// thing actually worth guarding against is stdio's own ~30-minute
// connection-idle timeout, which the SDK's Client models generically as
// resetTimeoutOnProgress on any request that opts in (a progressToken,
// supplied here via the SDK's own `onprogress` option). This drives a real
// MCP Client end to end, not a mock, with a deliberately short timeout the
// fake's own turn duration would otherwise blow through, standing in for
// that idle window without an actual 30-minute wait.
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

// Finding 5's whole point: InMemoryTransport (every test above) reliably
// calls onclose on client.close(), which made the registry-level test above
// pass even though production's real StdioServerTransport does not call
// onclose on a real shutdown at all (server/stdio.js registers no
// 'end'/'close' listener on stdin and installs no SIGTERM/SIGINT handler —
// see the onclose comment in src/mcp/server.ts). A test that only exercised
// InMemoryTransport would have stayed green with that gap wide open. This
// spawns a REAL child process running the REAL runStdioServer() bootstrap,
// talks to it over a REAL StdioClientTransport, and shuts it down exactly
// the way that transport's own close() does: stdin.end(), then (if that
// doesn't land in time) SIGTERM, then SIGKILL.
//
// Verified by mutation: with the SIGTERM/SIGINT/stdin 'end'/'close'
// listeners removed from runStdioServer(), this test fails with the
// grandchild still alive after client.close() returns; restored, it passes.
test("a real stdio shutdown (stdin end, then SIGTERM, then SIGKILL) disposes every dispatched run's process tree", async () => {
  const workdir = tmpWorkdir();
  const scriptDir = mkdtempSync(join(tmpdir(), "omp-agent-stdio-"));
  const scriptPath = join(scriptDir, "run-server.ts");
  const serverPath = new URL("../src/mcp/server.ts", import.meta.url).pathname;
  writeFileSync(scriptPath, `
import { runStdioServer } from ${JSON.stringify(serverPath)};
await runStdioServer({ command: ${JSON.stringify(FAKE_COMMAND)} });
`);

  const transport = new StdioClientTransport({
    command: "bun",
    args: [scriptPath],
    env: {
      ...(process.env as Record<string, string>),
      FAKE_OMP_SCRIPT: JSON.stringify({ spawnGrandchild: true }),
    },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    const r: any = await client.callTool({
      name: "omp_agent",
      arguments: { description: "spawn a grandchild", prompt: "go", workdir },
    });
    expect(r.isError).toBeFalsy();

    const pidFile = join(workdir, "grandchild.pid");
    await waitForFile(pidFile);
    const gcPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(gcPid)).toBe(true);   // sanity: the descendant actually started

    // The SDK's own client-side shutdown sequence — see
    // StdioClientTransport.close() in @modelcontextprotocol/sdk: stdin.end(),
    // then SIGTERM if the process hasn't exited within ~2s, then SIGKILL if
    // it still hasn't.
    await client.close();

    const deadline = Date.now() + 5000;
    while (isAlive(gcPid) && Date.now() < deadline) {
      await new Promise(r2 => setTimeout(r2, 20));
    }
    expect(isAlive(gcPid)).toBe(false);
  } finally {
    await client.close().catch(() => {});
  }
}, 30_000);

// Regression for the trailing-dash bug fixed this round: slicing to 40 chars
// after the dash-trim (rather than before) could cut a description right
// after a separator, leaving the slug ending in "-" and, on collision,
// producing a double dash ("...a--2") instead of "...a-2".
test("uniqueName trims a trailing dash left by slicing, including on collision", () => {
  const desc = `${"a".repeat(39)}-${"b".repeat(10)}`;   // the 40th char is "-"
  const taken = new Set<string>();
  const first = uniqueName(desc, n => taken.has(n));
  expect(first).toBe("a".repeat(39));
  taken.add(first);
  const second = uniqueName(desc, n => taken.has(n));
  expect(second).toBe(`${"a".repeat(39)}-2`);
});

// --- Task 7: agent definitions applied, and refused rather than weakened ---

import { mkdirSync } from "node:fs";

/**
 * A project tree with its own .claude/agents. Never the developer's real one:
 * a test that depends on whose machine it runs on is not a test.
 */
function projectWithAgents(defs: Record<string, string>): string {
  const workdir = mkdtempSync(join(tmpdir(), "omp-agent-defs-"));
  const dir = join(workdir, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(defs)) {
    writeFileSync(join(dir, `${file}.md`), body);
  }
  return workdir;
}

const agentDef = (name: string, extra: string) =>
  `---\nname: ${name}\ndescription: the ${name} agent\n${extra}---\nYou are ${name}. Be brief.\n`;

async function dispatch(client: Client, args: Record<string, unknown>) {
  return (await client.callTool({ name: "omp_agent", arguments: args })) as any;
}

test("subagent_type applies the definition's tools and system prompt", async () => {
  const workdir = projectWithAgents({
    scout: agentDef("scout", "tools: Read, Grep\nmaxTurns: 7\n"),
  });
  const dumpDir = mkdtempSync(join(tmpdir(), "omp-t7-dump-"));
  const dump = join(dumpDir, "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  try {
    const client = await connect();
    await dispatch(client, { description: "scout it", prompt: "go", subagent_type: "scout", workdir });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const argv: string[] = seen.argv;
    expect(argv).toContain("--tools=read,grep");
    const sysArg = argv.find(a => a.startsWith("--append-system-prompt"));
    expect(sysArg).toBeDefined();
  } finally {
    delete process.env.FAKE_OMP_DUMP;
  }
}, 30_000);

test("the definition's maxTurns is applied", async () => {
  const workdir = projectWithAgents({
    tight: agentDef("tight", "tools: Read\nmaxTurns: 1\n"),
  });
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnCostUsd: 0, toolCallsPerTurn: 1 });
  const client = await connect();
  const r = await dispatch(client, { description: "tight run", prompt: "go", subagent_type: "tight", workdir });
  expect(r.content[0].text).toContain("max_turns");
}, 30_000);

// The footer's model= reports what the AGENT said about itself (RunResult.model),
// which for the fake is always fake/fake-1. What model was REQUESTED is only
// observable in the argv the child was launched with, so assert there.
test("the definition's model is used when no explicit model is given", async () => {
  const workdir = projectWithAgents({
    picky: agentDef("picky", "tools: Read\nmodel: zai/glm-4.7\n"),
  });
  const dump = join(mkdtempSync(join(tmpdir(), "omp-t7-model-")), "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  try {
    const client = await connect();
    await dispatch(client, { description: "picky run", prompt: "go", subagent_type: "picky", workdir });
    expect(JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).argv)).toContain("glm-4.7");
  } finally {
    delete process.env.FAKE_OMP_DUMP;
  }
}, 30_000);

test("an explicit model argument beats the definition's", async () => {
  const workdir = projectWithAgents({
    picky: agentDef("picky", "tools: Read\nmodel: haiku\n"),
  });
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const client = await connect();
  const dump = join(mkdtempSync(join(tmpdir(), "omp-t7-override-")), "argv.json");
  process.env.FAKE_OMP_DUMP = dump;
  try {
    await dispatch(client, {
      description: "override run", prompt: "go", subagent_type: "picky",
      model: "opus", workdir,
    });
    const argv = JSON.stringify(JSON.parse(readFileSync(dump, "utf8")).argv);
    expect(argv).toContain("glm-5.3");
    expect(argv).not.toContain("deepseek-flash");
  } finally {
    delete process.env.FAKE_OMP_DUMP;
  }
}, 30_000);

test("a definition requiring Skill is refused, and the message names Skill", async () => {
  const workdir = projectWithAgents({
    skilled: agentDef("skilled", "tools: Read, Skill\n"),
  });
  const client = await connect();
  const r = await dispatch(client, { description: "skilled run", prompt: "go", subagent_type: "skilled", workdir });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toContain("Skill");
}, 30_000);

test("the refusal names every dropped tool, not just the first", async () => {
  const workdir = projectWithAgents({
    many: agentDef("many", "tools: Read, Skill, ToolSearch, mcp__foo__bar\n"),
  });
  const client = await connect();
  const r = await dispatch(client, { description: "many run", prompt: "go", subagent_type: "many", workdir });
  const text = JSON.stringify(r.content);
  expect(text).toContain("Skill");
  expect(text).toContain("ToolSearch");
  expect(text).toContain("mcp__foo__bar");
}, 30_000);

test("an unknown subagent_type errors listing the available names", async () => {
  const workdir = projectWithAgents({
    scout: agentDef("scout", "tools: Read\n"),
    tight: agentDef("tight", "tools: Read\n"),
  });
  const client = await connect();
  const r = await dispatch(client, { description: "typo run", prompt: "go", subagent_type: "scowt", workdir });
  expect(r.isError).toBe(true);
  const text = JSON.stringify(r.content);
  expect(text).toContain("scowt");
  expect(text).toContain("scout");
  expect(text).toContain("tight");
}, 30_000);

test("a discovery error in one file does not prevent using a valid definition", async () => {
  const workdir = projectWithAgents({
    good: agentDef("good", "tools: Read\n"),
    broken: "this file has no front matter",
  });
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const client = await connect();
  const r = await dispatch(client, { description: "good run", prompt: "go", subagent_type: "good", workdir });
  expect(r.isError).toBeFalsy();
}, 30_000);

test("no subagent_type still works, using the defaults", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ replies: ["defaulted"] });
  const client = await connect();
  const r = await dispatch(client, { description: "plain run", prompt: "go" });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("defaulted");
}, 30_000);
