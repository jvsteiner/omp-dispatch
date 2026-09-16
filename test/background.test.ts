import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

const clients: Client[] = [];
let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-bg-home-"));
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  delete process.env.FAKE_OMP_SCRIPT;
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
const start = (c: Client, args: Record<string, unknown> = {}) => call(c, "omp_agent", {
  description: "background task", prompt: "go", name: "worker",
  workdir: mkdtempSync(join(tmpdir(), "omp-bg-work-")), run_in_background: true, ...args,
});
const output = (c: Client, wait_seconds = 5) =>
  call(c, "omp_task_output", { name: "worker", wait_seconds });

test("background dispatch returns while running, bounded polling collects the final report", async () => {
  const c = await connect({ turnDelayMs: 1000, replies: ["the final answer"] });
  expect((await start(c)).isError).toBeFalsy();
  const pending = await output(c, 0.01);
  expect(pending.content[0].text).toContain("state=running");
  expect(pending.content[0].text).not.toContain("the final answer");
  const result = await output(c);
  expect(result.isError).toBeFalsy();
  expect(result.content[0].text).toContain("the final answer");
  expect(result.content[0].text).toContain("stopped_because=completed");
  // Served in full once; a re-collect gets the tombstone, not a second copy
  // of the same report.
  const again = await output(c, 0);
  expect(again.isError).toBeFalsy();
  expect(again.content[0].text).toContain("already delivered this session");
  expect(again.content[0].text).toContain("stopped_because=completed");
  expect(again.content[0].text).not.toContain("the final answer");
});

test("background follow-up runs another turn and replaces the collected report", async () => {
  const c = await connect({ turnDelayMs: 300 });
  await start(c);
  expect((await output(c)).content[0].text).toContain("turns=1");
  const followup = await call(c, "omp_send_message", {
    to: "worker", message: "continue", run_in_background: true,
  });
  expect(followup.isError).toBeFalsy();
  expect((await output(c, 0)).content[0].text).toContain("state=running");
  expect((await output(c)).content[0].text).toContain("turns=2");
});

test("supervisor questions are visible and answerable after background dispatch", async () => {
  const c = await connect({ askOnTurn: 1 });
  await start(c);
  const question = await output(c, 0.1);
  expect(question.content[0].text).toContain("Which page wins when two disagree?");
  expect((await call(c, "omp_answer", { name: "worker", text: "The newer page." })).isError).toBeFalsy();
  expect((await output(c)).content[0].text).toContain("stopped_because=completed");
});

test("a crashed background child returns a persistent error rather than disappearing", async () => {
  const c = await connect({ crashAfterPrompt: true });
  await start(c);
  const result = await output(c);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("did not complete");
  expect(await output(c, 0)).toEqual(result);
});

test("background runs can be stopped and caps remain partial results", async () => {
  const c = await connect({ turnDelayMs: 2000 });
  await start(c);
  expect((await call(c, "omp_task_stop", { name: "worker" })).isError).toBeFalsy();
  expect((await output(c)).content[0].text).toContain("stopped_because=aborted");

  const capped = await connect({ turnCostUsd: 2 });
  await start(capped);
  const result = await output(capped);
  expect(result.isError).toBeFalsy();
  expect(result.content[0].text).toContain("stopped_because=max_usd");
});

test("worktree cleanup completes before a background result is collected", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-bg-git-"));
  await Bun.$`git init -q ${workdir}`.quiet();
  await Bun.$`git -C ${workdir} -c user.name=Test -c user.email=test@example.com commit --allow-empty -qm init`.quiet();
  const c = await connect();
  await start(c, { workdir, isolation: "worktree" });
  const result = await output(c);
  expect(result.isError).toBeFalsy();
  expect(result.content[0].text).toContain("worktree was clean and has been removed");
  const worktrees = await Bun.$`git -C ${workdir} worktree list --porcelain`.quiet();
  expect(worktrees.stdout.toString().match(/^worktree /gm)?.length).toBe(1);
});

test("Codex can use a neutral role definition and polling rejects excessive waits", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-bg-role-"));
  mkdirSync(join(workdir, ".omp-dispatch", "agents"), { recursive: true });
  writeFileSync(join(workdir, ".omp-dispatch", "agents", "reader.md"),
    "---\nname: reader\ntools: Read\nmaxTurns: 1\n---\nRead only.\n");
  const c = await connect();
  expect((await start(c, { workdir, subagent_type: "reader" })).isError).toBeFalsy();
  expect(existsSync(join(workdir, ".claude"))).toBe(false);
  expect((await output(c)).content[0].text).toContain("turns=1");
  expect((await output(c, 111)).isError).toBe(true);
});
