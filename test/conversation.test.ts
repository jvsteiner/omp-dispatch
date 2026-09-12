import { test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

const FAKE_COMMAND = ["bun", join(import.meta.dir, "fake-omp.ts")];
const openClients: Client[] = [];

async function connect(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([createServer({ command: FAKE_COMMAND }).connect(a), client.connect(b)]);
  openClients.push(client);
  return client;
}

let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-conv-home-"));
});
afterAll(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
});
afterEach(async () => {
  while (openClients.length) await openClients.pop()!.close().catch(() => {});
  delete process.env.FAKE_OMP_SCRIPT;
});

const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<any>;

const dispatch = (c: Client, args: Record<string, unknown>) =>
  call(c, "omp_agent", { description: "a run", prompt: "go", ...args });

// --- omp_send_message -----------------------------------------------------

// Asserting on the reply TEXT alone proves nothing here: the fake's first run
// already consumes both scripted replies, so last_reply is "second" before any
// resume happens. The turn count is what only a real second turn can move.
test("omp_send_message continues a completed run, running a further turn", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ replies: ["first", "second", "third"] });
  const c = await connect();
  const first = await dispatch(c, { name: "chatty" });
  const turnsBefore = Number(/turns=(\d+)/.exec(first.content[0].text)![1]);

  const r = await call(c, "omp_send_message", { to: "chatty", message: "and then?" });
  expect(r.isError).toBeFalsy();
  const turnsAfter = Number(/turns=(\d+)/.exec(r.content[0].text)![1]);
  expect(turnsAfter).toBeGreaterThan(turnsBefore);
}, 40_000);

test("omp_send_message on an unknown name errors listing the known ones", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const c = await connect();
  await dispatch(c, { name: "alpha" });
  const r = await call(c, "omp_send_message", { to: "beta", message: "hi" });
  expect(r.isError).toBe(true);
  const text = JSON.stringify(r.content);
  expect(text).toContain("beta");
  expect(text).toContain("alpha");
}, 40_000);

// --- omp_list_agents ------------------------------------------------------

test("omp_list_agents reports a settled run with its state and cost", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnCostUsd: 0.02 });
  const c = await connect();
  await dispatch(c, { name: "listed" });
  const r = await call(c, "omp_list_agents");
  const text = r.content[0].text;
  expect(text).toContain("listed");
  expect(text).toContain("completed");
  expect(text).toContain("0.02");
}, 40_000);

test("omp_list_agents says so plainly when nothing has run", async () => {
  const c = await connect();
  const r = await call(c, "omp_list_agents");
  expect(r.content[0].text).toMatch(/no .*agents|none/i);
}, 20_000);

// --- a run still in flight ------------------------------------------------

test("a run is listable and steerable before it settles", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 4000, replies: ["slow"] });
  const c = await connect();
  const inFlight = dispatch(c, { name: "slowpoke" });
  // Give the dispatch time to start the run and register it, but not finish.
  await Bun.sleep(1500);

  const listed = await call(c, "omp_list_agents");
  expect(listed.content[0].text).toContain("slowpoke");
  expect(listed.content[0].text).toContain("running");

  const steered = await call(c, "omp_steer", { to: "slowpoke", message: "actually, stop that" });
  expect(steered.isError).toBeFalsy();

  await inFlight;
}, 40_000);

test("omp_task_output returns progress for a run in flight", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 4000 });
  const c = await connect();
  const inFlight = dispatch(c, { name: "tailme" });
  await Bun.sleep(1500);
  const r = await call(c, "omp_task_output", { name: "tailme" });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("START");
  await inFlight;
}, 40_000);

test("omp_task_stop settles a run in flight as aborted", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 6000 });
  const c = await connect();
  const inFlight = dispatch(c, { name: "stopme" });
  await Bun.sleep(1500);
  const r = await call(c, "omp_task_stop", { name: "stopme" });
  expect(r.isError).toBeFalsy();
  const settled = await inFlight;
  expect(settled.content[0].text).toContain("aborted");
}, 40_000);

// --- every tool names the run it could not find ----------------------------

test("steer, task_output and task_stop all error clearly on an unknown name", async () => {
  const c = await connect();
  for (const tool of ["omp_steer", "omp_task_output", "omp_task_stop"]) {
    const args = tool === "omp_steer"
      ? { to: "ghost", message: "x" }
      : { name: "ghost" };
    const r = await call(c, tool, args);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("ghost");
  }
}, 30_000);

// --- ask_supervisor: the agent asks Claude a question ----------------------

test("an agent that asks parks the run, and omp_answer resumes it", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ askOnTurn: 1, turnCostUsd: 0.01 });
  const c = await connect();
  const inFlight = dispatch(c, { name: "asker" });

  // Wait for the run to park on its question rather than finish.
  let listed = "";
  for (let i = 0; i < 60 && !listed.includes("asking"); i++) {
    await Bun.sleep(100);
    listed = (await call(c, "omp_list_agents")).content[0].text;
  }
  expect(listed).toContain("asking");

  const tail = (await call(c, "omp_task_output", { name: "asker" })).content[0].text;
  expect(tail).toContain("ASK");

  const answered = await call(c, "omp_answer", { name: "asker", text: "the older page wins" });
  expect(answered.isError).toBeFalsy();

  const settled = await inFlight;
  expect(settled.content[0].text).toContain("stopped_because=completed");
}, 40_000);

test("omp_answer on a run that is not asking errors, naming its state", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const c = await connect();
  await dispatch(c, { name: "quiet" });
  const r = await call(c, "omp_answer", { name: "quiet", text: "hello?" });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toContain("not waiting");
}, 40_000);

// A run stopped while a question is parked must not leave the agent waiting on
// an answer that can never come — teardown rejects everything outstanding.
test("stopping a run that is asking settles it rather than hanging", async () => {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ askOnTurn: 1, turnCostUsd: 0.01 });
  const c = await connect();
  const inFlight = dispatch(c, { name: "stuck" });

  let listed = "";
  for (let i = 0; i < 60 && !listed.includes("asking"); i++) {
    await Bun.sleep(100);
    listed = (await call(c, "omp_list_agents")).content[0].text;
  }
  expect(listed).toContain("asking");

  await call(c, "omp_task_stop", { name: "stuck" });
  const settled = await inFlight;          // must not hang
  expect(settled.content[0].text).toContain("aborted");
}, 40_000);

// --- worktree isolation ----------------------------------------------------

test("isolation: worktree runs the agent in its own checkout", async () => {
  const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const repo = mk(join(tmpdir(), "omp-iso-"));
  await Bun.$`git init -q`.cwd(repo).quiet();
  wf(join(repo, "seed.txt"), "seed\n");
  await Bun.$`git add -A`.cwd(repo).quiet();
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(repo).quiet();

  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const c = await connect();
  const r = await dispatch(c, { name: "isolated", isolation: "worktree", workdir: repo });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("worktree");

  // The agent wrote nothing, so the main tree must be untouched.
  const status = await Bun.$`git status --porcelain`.cwd(repo).quiet();
  expect(status.stdout.toString().trim()).toBe("");
}, 40_000);

test("isolation: worktree on a non-repo errors instead of running unisolated", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  const notRepo = mk(join(tmpdir(), "omp-iso-bare-"));
  const c = await connect();
  const r = await dispatch(c, { name: "norepo", isolation: "worktree", workdir: notRepo });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toContain("run without isolation");
}, 40_000);
