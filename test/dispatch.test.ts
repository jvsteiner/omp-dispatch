import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";
import { listRuns } from "../src/rundir.ts";

/**
 * The calling-agent surface added for delegation review: what a background
 * start acknowledges (resolved model and caps, catchable at t=0), session
 * usage totals, the doctor, and diff-included collection.
 */
const clients: Client[] = [];
let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-dispatch-home-"));
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  delete process.env.FAKE_OMP_SCRIPT;
});

async function connect(command?: string[]) {
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dispatch-test", version: "0" }, { capabilities: {} });
  await Promise.all([
    createServer({ command: command ?? ["bun", join(import.meta.dir, "fake-omp.ts")] }).connect(a),
    client.connect(b),
  ]);
  clients.push(client);
  return client;
}

const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<any>;

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-dispatch-repo-"));
  writeFileSync(join(dir, "seed.md"), "seed\n");
  Bun.$`git init -q`.cwd(dir).quiet();
  Bun.$`git add -A`.cwd(dir).quiet();
  Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir).quiet();
  return dir;
}

test("a background start acknowledges the resolved model and caps before any spend", async () => {
  const c = await connect();
  const r: any = await call(c, "omp_agent", {
    description: "ack check", prompt: "go", name: "ack",
    workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")), run_in_background: true,
  });
  expect(r.isError).toBeFalsy();
  const text = r.content[0].text as string;
  // model= catches a wrong tier choice at t=0; caps state the run's budget.
  expect(text).toMatch(/model=deepseek\/deepseek-flash /);
  expect(text).toContain("max_turns=120 max_usd=1.00 max_seconds=1200");
  expect(text).toContain("Collect with omp_task_output");
  // the correction affordance must name the stop-then-redispatch path
  expect(text).toContain("Wrong model?");
  await call(c, "omp_task_output", { name: "ack", wait_seconds: 5 });
});

function gitRepo(): Promise<string> {
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-dispatch-repo-"));
    writeFileSync(join(dir, "seed.md"), "seed\n");
    await Bun.$`git init -q`.cwd(dir).quiet();
    await Bun.$`git add -A`.cwd(dir).quiet();
    await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir).quiet();
    return dir;
  })();
}

test("a tier resolves through the map and the resolved id is echoed in the ack", async () => {
  const c = await connect();
  const r: any = await call(c, "omp_agent", {
    description: "tier model", prompt: "go", name: "explicit",
    model: "opus", run_in_background: true,
    workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")),
  });
  const text = r.content[0].text as string;
  // 'opus' is the caller's word; the ack reports the user's model behind it,
  // so a wrong mapping is catchable at t=0.
  expect(text).toMatch(/model=zai\/glm-5\.3 /);
  await call(c, "omp_task_output", { name: "explicit", wait_seconds: 5 });
});

test("omp_usage totals the session's dispatched runs", async () => {
  const c = await connect();
  for (const name of ["one", "two"]) {
    await call(c, "omp_agent", {
      description: name, prompt: "go", name,
      workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")), run_in_background: true,
    });
  }
  await call(c, "omp_task_output", { name: "one", wait_seconds: 5 });
  await call(c, "omp_task_output", { name: "two", wait_seconds: 5 });

  const r: any = await call(c, "omp_usage", {});
  expect(r.isError).toBeFalsy();
  const text = r.content[0].text as string;
  expect(text).toContain("runs=2 (completed=2");
  // fake-omp's default turn costs $0.01; two one-turn runs
  expect(text).toContain("turns=2 tool_calls=4 cost_usd=0.0200");
  expect(text).toContain("two  completed");
});

test("omp_usage with no runs says so instead of an empty table", async () => {
  const c = await connect();
  const r: any = await call(c, "omp_usage", {});
  expect(r.content[0].text).toContain("No omp agents have run in this session.");
});

test("omp_doctor reports every dependency of a dispatch", async () => {
  const c = await connect();
  const r: any = await call(c, "omp_doctor", { workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")) });
  expect(r.isError).toBeFalsy();
  const text = r.content[0].text as string;
  expect(text).toMatch(/OK\s+runtime\s+bun \d/);
  expect(text).toMatch(/OK\s+omp /);
  expect(text).toMatch(/(OK|NOTE)\s+providers /);
  expect(text).toMatch(/OK\s+tiers\s+default sonnet -> deepseek\/deepseek-flash/);
  expect(text).toMatch(/OK\s+runs\s+dir\s+writable: /);
  expect(text).toMatch(/doctor: 7\/7 checks passed/);
});

test("omp_doctor fails loudly when an omp database cannot be written", async () => {
  const c = await connect();
  // A corrupt "database" is the deterministic stand-in for the real-world
  // failure class (locked, read-only, corrupt): omp --version still exits 0,
  // so this is precisely what the version-only check used to miss.
  const home = mkdtempSync(join(tmpdir(), "omp-dispatch-brokenhome-"));
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "models.db"), "not a sqlite database at all");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const r: any = await call(c, "omp_doctor", { workdir: "/tmp" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("FAIL databases");
    expect(r.content[0].text).toContain("file is not a database");
    expect(r.content[0].text).toMatch(/doctor: [67]\/7 checks passed/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("a poll of a running dispatch shows turns, cost and elapsed, not just state", async () => {
  const c = await connect();
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 900, replies: ["the report"] });
  const repo = await gitRepo();
  await call(c, "omp_agent", {
    description: "live status", prompt: "go", name: "live",
    workdir: repo, run_in_background: true,
  });
  const r: any = await call(c, "omp_task_output", { name: "live", wait_seconds: 0.01 });
  const text = r.content[0].text as string;
  expect(text).toMatch(/state=running turns=\d+ cost_usd=[\d.]+ elapsed=\d+s/);
  // the log answers "is it working", not just "is it alive"
  expect(text).toContain("START deepseek/deepseek-flash");
  expect(text).toContain("PROMPT submitted");
  await call(c, "omp_task_output", { name: "live", wait_seconds: 10 });
});

test("a definition-less dispatch runs under the fire-and-forget reporting contract", async () => {
  const c = await connect();
  const dump = join(mkdtempSync(join(tmpdir(), "omp-dispatch-dump-")), "args.json");
  process.env.FAKE_OMP_DUMP = dump;
  try {
    await call(c, "omp_agent", {
      description: "contract", prompt: "go", name: "contract",
      workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")),
    });
    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    const promptArg = argv.find((a: string) => a.includes("fire-and-forget"));
    expect(promptArg).toBeDefined();
    expect(promptArg).toContain("At most three bullets");
  } finally {
    delete process.env.FAKE_OMP_DUMP;
  }
});

test("a definition's own system prompt replaces the default contract", async () => {
  const c = await connect();
  const dump = join(mkdtempSync(join(tmpdir(), "omp-dispatch-dump-")), "args.json");
  process.env.FAKE_OMP_DUMP = dump;
  const home = mkdtempSync(join(tmpdir(), "omp-dispatch-defhome-"));
  mkdirSync(join(home, ".omp-dispatch", "agents"), { recursive: true });
  writeFileSync(join(home, ".omp-dispatch", "agents", "terse-tester.md"),
    "---\nname: terse-tester\ndescription: test\nmodel: sonnet\n---\nYou are a custom voice.\n");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await call(c, "omp_agent", {
      description: "custom def", prompt: "go", name: "customdef", subagent_type: "terse-tester",
      workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")),
    });
    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    const promptArg = argv.find((a: string) => a.includes("custom voice")) as string | undefined;
    expect(promptArg).toBeDefined();
    expect(promptArg).not.toContain("fire-and-forget");
  } finally {
    process.env.HOME = originalHome;
    delete process.env.FAKE_OMP_DUMP;
  }
});

test("a failed dispatch explains itself with the doctor instead of a second call", async () => {
  const c = await connect(["bun", "/definitely/not/a/real/omp.ts"]);
  const start: any = await call(c, "omp_agent", {
    description: "doomed", prompt: "go", name: "doomed", run_in_background: true,
    workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")),
  });
  expect(start.isError).toBeFalsy();
  const r: any = await call(c, "omp_task_output", { name: "doomed", wait_seconds: 5 });
  expect(r.isError).toBe(true);
  const text = r.content[0].text as string;
  expect(text).toContain("did not complete");
  expect(text).toMatch(/doctor: [67]\/7 checks passed|FAIL/);
});

test("a settled run collects with its git diff, and the footer points at diff.patch", async () => {
  const c = await connect();
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({ turnDelayMs: 600, replies: ["the report"] });
  const repo = await gitRepo();
  const start: any = await call(c, "omp_agent", {
    description: "diff check", prompt: "go", name: "diffy",
    workdir: repo, run_in_background: true,
  });
  expect(start.isError).toBeFalsy();

  // The change lands once the run is verifiably in flight (progress.log's
  // START line), not after a guessed delay; turnDelayMs keeps the turn open
  // long enough for the write to land inside the run. Real subprocess, so
  // real time is the only clock available here.
  const logPath = join(listRuns(repo)[0]!.dir, "progress.log");
  const startDeadline = Date.now() + 5000;
  while (!(readFileSync(logPath, "utf8").includes("START") || Date.now() > startDeadline)) {
    await Bun.sleep(20);
  }
  writeFileSync(join(repo, "agent-change.md"), "made by the run\n");

  const plain: any = await call(c, "omp_task_output", { name: "diffy", wait_seconds: 10 });
  const plainText = plain.content[0].text as string;
  expect(plainText).toContain("stopped_because=completed");
  expect(plainText).toContain("files_changed=agent-change.md");
  expect(plainText).toMatch(/diff=\S+diff\.patch/);
  // diff is opt-in: the settled report alone does not carry it
  expect(plainText).not.toContain("--- diff (git-derived");

  const withDiff: any = await call(c, "omp_task_output", { name: "diffy", include_diff: true });
  const diffText = withDiff.content[0].text as string;
  expect(diffText).toContain("--- diff (git-derived, vs run start) ---");
  expect(diffText).toContain("+made by the run");

  // the patch also exists on disk, where the CLI and later sessions read it
  const runs = listRuns(repo);
  const run = runs.find(x => x.result.name === "diffy")!;
  expect(run).toBeDefined();
  expect(readFileSync(join(run.dir, "diff.patch"), "utf8")).toContain("+made by the run");
});

test("a run that changes nothing reports no diff rather than an empty patch", async () => {
  const c = await connect();
  await call(c, "omp_agent", {
    description: "clean run", prompt: "go", name: "clean",
    workdir: mkdtempSync(join(tmpdir(), "omp-dispatch-w-")), run_in_background: true,
  });
  const r: any = await call(c, "omp_task_output", { name: "clean", wait_seconds: 5, include_diff: true });
  const text = r.content[0].text as string;
  expect(text).toContain("stopped_because=completed");
  expect(text).toContain("(no file changes — no diff was written)");
  expect(text).not.toContain("files_changed=");
});

test("the run's chosen name is persisted into result.json for disk readers", async () => {
  const c = await connect();
  const workdir = mkdtempSync(join(tmpdir(), "omp-dispatch-w-"));
  await call(c, "omp_agent", {
    description: "named run", prompt: "go", name: "persisted-name",
    workdir, run_in_background: true,
  });
  await call(c, "omp_task_output", { name: "persisted-name", wait_seconds: 5 });
  const run = listRuns(workdir).find(x => x.result.name === "persisted-name");
  expect(run).toBeDefined();
  expect(existsSync(join(run!.dir, "result.json"))).toBe(true);
});
