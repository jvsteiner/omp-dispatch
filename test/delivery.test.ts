import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

// Delivery-shape behaviors: block-bounded foreground dispatch, serve-once
// tombstones, omp_wait set semantics, and the shared-workdir concurrency
// guard — the fixes for duplicated results, polling misery and interleaved
// workdirs reported by the Codex supervisor on 2026-09-16.
//
// A fake-omp child bakes FAKE_OMP_SCRIPT in at spawn, so tests that need two
// different speeds mutate process.env between dispatches, never after.

const clients: Client[] = [];
let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-delivery-home-"));
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  delete process.env.FAKE_OMP_SCRIPT;
  delete process.env.OMP_DISPATCH_BLOCK_MS;
});

async function connect(script: object = {}) {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify(script);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-test", version: "0" }, { capabilities: {} });
  await Promise.all([
    createServer({ command: ["bun", join(import.meta.dir, "fake-omp.ts")] }).connect(a),
    client.connect(b),
  ]);
  clients.push(client);
  return client;
}

const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<any>;

const workdir = () => mkdtempSync(join(tmpdir(), "omp-delivery-w-"));

async function gitRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "omp-delivery-git-"));
  await Bun.$`git init -q ${repo}`.quiet();
  await Bun.$`git -C ${repo} -c user.name=Test -c user.email=test@example.com commit --allow-empty -qm init`.quiet();
  return repo;
}

test("a foreground dispatch outlasting the block bound hands off instead of erroring", async () => {
  process.env.OMP_DISPATCH_BLOCK_MS = "80";
  const c = await connect({ turnDelayMs: 400, replies: ["the slow report"] });
  const dispatch: any = await call(c, "omp_agent", {
    description: "slow task", prompt: "go", name: "slow", workdir: workdir(),
  });
  expect(dispatch.isError).toBeFalsy();
  expect(dispatch.content[0].text).toContain("Still running 'slow'");
  expect(dispatch.content[0].text).toContain("handoff, not an error");
  expect(dispatch.content[0].text).toContain("omp_task_output");
  expect(dispatch.content[0].text).not.toContain("the slow report");
  const collected: any = await call(c, "omp_task_output", { name: "slow", wait_seconds: 10 });
  expect(collected.isError).toBeFalsy();
  expect(collected.content[0].text).toContain("the slow report");
  expect(collected.content[0].text).toContain("stopped_because=completed");
});

test("a foreground result delivered inline is not re-served by omp_task_output", async () => {
  const c = await connect({ turnDelayMs: 10, replies: ["the inline report"] });
  const dispatch: any = await call(c, "omp_agent", {
    description: "fast task", prompt: "go", name: "fast", workdir: workdir(),
  });
  expect(dispatch.isError).toBeFalsy();
  expect(dispatch.content[0].text).toContain("the inline report");
  const again: any = await call(c, "omp_task_output", { name: "fast", wait_seconds: 0 });
  expect(again.isError).toBeFalsy();
  expect(again.content[0].text).toContain("already delivered this session");
  expect(again.content[0].text).not.toContain("the inline report");
  // The diff surface stays available on the tombstone.
  const withDiff: any = await call(c, "omp_task_output", { name: "fast", include_diff: true });
  expect(withDiff.content[0].text).toContain("no file changes");
});

test("omp_wait returns the first settled run and summarizes the rest", async () => {
  const c = await connect({ turnDelayMs: 200, replies: ["report a"] });
  await call(c, "omp_agent", {
    description: "wait first", prompt: "go", name: "wfirst", workdir: workdir(), run_in_background: true,
  });
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 8000, replies: ["report b"] });
  const second: any = await call(c, "omp_agent", {
    description: "wait second", prompt: "go", name: "wsecond", workdir: workdir(), run_in_background: true,
  });
  expect(second.isError).toBeFalsy();
  const r: any = await call(c, "omp_wait", { names: ["wfirst", "wsecond"], wait_seconds: 10 });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("report a");
  expect(r.content[0].text).not.toContain("report b");
  expect(r.content[0].text).toContain("--- still running ---");
  expect(r.content[0].text).toMatch(/run 'wsecond': state=running/);
});

test("omp_wait with all: true returns every settled report", async () => {
  const c = await connect({ turnDelayMs: 150, replies: ["all a", "all b"] });
  await call(c, "omp_agent", {
    description: "all first", prompt: "go", name: "afirst", workdir: workdir(), run_in_background: true,
  });
  await call(c, "omp_agent", {
    description: "all second", prompt: "go", name: "asecond", workdir: workdir(), run_in_background: true,
  });
  const r: any = await call(c, "omp_wait", { names: ["afirst", "asecond"], all: true, wait_seconds: 15 });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("all a");
  // Both runs spawned from the same script, so both reply "all a"; what
  // all: true guarantees is that BOTH settled reports are present.
  expect(r.content[0].text).toContain("[omp:afirst]");
  expect(r.content[0].text).toContain("[omp:asecond]");
  expect(r.content[0].text.match(/all a/g)?.length).toBe(2);
  expect(r.content[0].text).not.toContain("--- still running ---");
});

test("an omp_wait timeout answers 'what is everyone doing', not just 'not yet'", async () => {
  const c = await connect({ turnDelayMs: 8000, replies: ["late report"] });
  await call(c, "omp_agent", {
    description: "late task", prompt: "go", name: "late", workdir: workdir(), run_in_background: true,
  });
  const r: any = await call(c, "omp_wait", { names: ["late"], wait_seconds: 0.3 });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("timed out after 0.3s");
  expect(r.content[0].text).toMatch(/run 'late': state=running turns=\d+ tool_calls=\d+/);
  expect(r.content[0].text).not.toContain("late report");
  await call(c, "omp_task_stop", { name: "late" });
});

test("a second shared dispatch into a busy workdir is refused; worktree and later dispatches are not", async () => {
  const repo = await gitRepo();
  const c = await connect({ turnDelayMs: 8000, replies: ["occupier report"] });
  const occupy: any = await call(c, "omp_agent", {
    description: "occupy workdir", prompt: "go", name: "occupier", workdir: repo, run_in_background: true,
  });
  expect(occupy.isError).toBeFalsy();

  const shared: any = await call(c, "omp_agent", {
    description: "contender", prompt: "go", name: "contender", workdir: repo,
  });
  expect(shared.isError).toBe(true);
  expect(shared.content[0].text).toContain("busy with in-flight run(s) occupier (running)");
  expect(shared.content[0].text).toContain('isolation: "worktree"');

  // An isolated dispatch into the same repo is the sanctioned way around the
  // guard. New child, new script: fast, so the test stays quick.
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 10, replies: ["iso report"] });
  const isolated: any = await call(c, "omp_agent", {
    description: "isolated contender", prompt: "go", name: "iso", workdir: repo, isolation: "worktree",
  });
  expect(isolated.isError).toBeFalsy();
  expect(isolated.content[0].text).toContain("worktree_branch=omp-dispatch/");
  expect(isolated.content[0].text).toContain(`worktree_base=${repo}`);

  // Once the occupier settles, the workdir is free again.
  await call(c, "omp_task_stop", { name: "occupier" });
  const after: any = await call(c, "omp_agent", {
    description: "after settle", prompt: "go", name: "after", workdir: repo,
  });
  expect(after.isError).toBeFalsy();
});

test("omp_list_agents shows where each run works", async () => {
  const repo = await gitRepo();
  const c = await connect({ turnDelayMs: 10, replies: ["placed report", "iso report"] });
  await call(c, "omp_agent", {
    description: "placed shared", prompt: "go", name: "placed", workdir: repo,
  });
  await call(c, "omp_agent", {
    description: "placed isolated", prompt: "go", name: "placed-iso", workdir: repo, isolation: "worktree",
  });
  const list: any = await call(c, "omp_list_agents", {});
  const text = list.content[0].text as string;
  expect(text).toContain(`placed  completed  turns=1 cost_usd=0.0100 workdir=${repo}`);
  expect(text).toContain(`worktree-of=${repo}`);
});

test("omp_send_message hands off at the same block bound instead of erroring", async () => {
  // Background-first so the slow turnDelay is baked into the child before
  // the follow-up: a live process keeps the script it spawned with.
  const c = await connect({ turnDelayMs: 400, replies: ["first reply", "second reply"] });
  await call(c, "omp_agent", {
    description: "block followup", prompt: "go", name: "blocky", workdir: workdir(), run_in_background: true,
  });
  const first: any = await call(c, "omp_task_output", { name: "blocky", wait_seconds: 10 });
  expect(first.content[0].text).toContain("first reply");
  process.env.OMP_DISPATCH_BLOCK_MS = "80";
  const follow: any = await call(c, "omp_send_message", { to: "blocky", message: "continue" });
  expect(follow.isError).toBeFalsy();
  expect(follow.content[0].text).toContain("Still continuing 'blocky'");
  expect(follow.content[0].text).not.toContain("second reply");
  const collected: any = await call(c, "omp_task_output", { name: "blocky", wait_seconds: 10 });
  expect(collected.content[0].text).toContain("second reply");
});
