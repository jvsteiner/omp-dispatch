import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { listRuns } from "../src/rundir.ts";

/**
 * The CLI is the MCP-outage interface, so it is tested through runCli itself
 * with the fake launcher — the same seam createServer exposes as `command`.
 * What matters here is contract, not coverage of every flag: a dispatched run
 * leaves a readable result on disk, names itself, cleans up its monitor
 * marker, and refuses loudly where it cannot help.
 */
const FAKE_COMMAND = ["bun", join(import.meta.dir, "fake-omp.ts")];

let originalHome: string | undefined;
beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "omp-cli-home-"));
  process.env.FAKE_OMP_SCRIPT = JSON.stringify({});
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.FAKE_OMP_SCRIPT;
});

async function cli(argv: string[]) {
  const chunks: string[] = [];
  const errs: string[] = [];
  const code = await runCli(argv, {
    command: FAKE_COMMAND,
    out: s => chunks.push(s),
    err: s => errs.push(s),
  });
  return { code, out: chunks.join(""), err: errs.join("") };
}

async function cliWithStdin(stdinText: string, argv: string[]) {
  const chunks: string[] = [];
  const errs: string[] = [];
  const code = await runCli(argv, {
    command: FAKE_COMMAND,
    out: s => chunks.push(s),
    err: s => errs.push(s),
    stdin: () => Promise.resolve(stdinText),
  });
  return { code, out: chunks.join(""), err: errs.join("") };
}

test("start dispatches, reports, persists the name, and removes its monitor marker", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  const r = await cli([
    "start", "--prompt", "do the thing", "--description", "cli smoke",
    "--workdir", workdir,
  ]);
  expect(r.err).toContain("START name=cli-smoke model=deepseek/deepseek-flash");
  expect(r.err).toContain("max_turns=120 max_usd=1.00 max_seconds=1200");
  expect(r.out).toContain("stopped_because=completed");
  expect(r.out).toContain("[omp:cli-smoke]");

  const run = listRuns(workdir)[0]!;
  expect(run.result.name).toBe("cli-smoke");
  expect(run.result.state).toBe("completed");
  // the monitor marker only exists while the run does
  expect(existsSync(join(run.dir, "monitor.pid"))).toBe(false);
});

test("start refuses a missing prompt instead of dispatching anything", async () => {
  const r = await cli(["start", "--workdir", mkdtempSync(join(tmpdir(), "omp-cli-work-"))]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("start requires a prompt: --prompt <text>, --prompt-file <path>, or --prompt - for stdin");
});

test("start reads the brief from --prompt-file", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  const brief = join(workdir, "brief.md");
  writeFileSync(brief, "A brief with 'quotes', \"double quotes\" and `backticks`.\n");
  const r = await cli(["start", "--prompt-file", brief, "--name", "filebrief", "--workdir", workdir]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("stopped_because=completed");
  expect(r.err).toContain("START name=filebrief");
});

test("start reads the brief from stdin via --prompt -", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  const r = await cliWithStdin("piped brief body", [
    "start", "--prompt", "-", "--name", "stdinbrief", "--workdir", workdir,
  ]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("stopped_because=completed");
});

test("start refuses two prompt sources rather than guessing", async () => {
  const r = await cli(["start", "--prompt", "x", "--prompt-file", "y",
    "--workdir", mkdtempSync(join(tmpdir(), "omp-cli-work-"))]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("pass only one prompt source");
});

test("start refuses an empty brief", async () => {
  const r = await cliWithStdin("   \n", [
    "start", "--prompt", "-", "--workdir", mkdtempSync(join(tmpdir(), "omp-cli-work-")),
  ]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("was empty");
});

test("start names the file it cannot read", async () => {
  const r = await cli(["start", "--prompt-file", "/no/such/brief.md",
    "--workdir", mkdtempSync(join(tmpdir(), "omp-cli-work-"))]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("cannot read --prompt-file /no/such/brief.md");
});

test("start refuses an unknown agent definition with the shared refusal text", async () => {
  const r = await cli([
    "start", "--prompt", "go", "--subagent-type", "nope",
    "--workdir", mkdtempSync(join(tmpdir(), "omp-cli-work-")),
  ]);
  expect(r.code).toBe(1);
  // Same words omp_agent produces — one dialect of refusal, not two.
  expect(r.err).toContain("omp_agent: no agent definition named 'nope'");
});

test("list and output read what start wrote, by name and by latest", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  await cli(["start", "--prompt", "go", "--name", "findable", "--workdir", workdir]);

  const list = await cli(["list", "--workdir", workdir]);
  expect(list.out).toMatch(/findable\s+completed\s+turns=1/);

  const byName = await cli(["output", "findable", "--workdir", workdir]);
  expect(byName.out).toContain("stopped_because=completed");

  const latest = await cli(["output", "latest", "--workdir", workdir, "--diff"]);
  expect(latest.out).toContain("(no file changes — no diff was written)");
});

test("output for an unknown reference names what is on disk", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  await cli(["start", "--prompt", "go", "--name", "known", "--workdir", workdir]);
  const r = await cli(["output", "missing", "--workdir", workdir]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no run 'missing'");
  expect(r.err).toContain("known");
});

test("stop without a monitor explains the MCP alternative", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  await cli(["start", "--prompt", "go", "--name", "settled", "--workdir", workdir]);
  const r = await cli(["stop", "settled", "--workdir", workdir]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("omp_task_stop");
});

test("stop refuses to signal a pid that is no longer a dispatch monitor", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  await cli(["start", "--prompt", "go", "--name", "stale", "--workdir", workdir]);
  const run = listRuns(workdir)[0]!;
  // this test process is alive but is not a dispatch monitor — exactly the
  // recycled-pid hazard the guard exists for
  writeFileSync(join(run.dir, "monitor.pid"), `${process.pid}\n`);
  const r = await cli(["stop", "stale", "--workdir", workdir]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no longer a dispatch monitor");
});

test("usage totals the runs on disk for the workdir", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  await cli(["start", "--prompt", "go", "--name", "u1", "--workdir", workdir]);
  const r = await cli(["usage", "--workdir", workdir]);
  expect(r.out).toContain("runs=1 (completed=1");
  expect(r.out).toContain("cost_usd=0.0100");
});

test("doctor runs from the CLI and reports the same checks as the tool", async () => {
  const r = await cli(["doctor", "--workdir", mkdtempSync(join(tmpdir(), "omp-cli-work-"))]);
  expect(r.out).toContain("doctor: 7/7 checks passed");
  expect(r.code).toBe(0);
});

test("doctor fails loudly when an omp database is locked", async () => {
  const { Database } = await import("bun:sqlite");
  const home = mkdtempSync(join(tmpdir(), "omp-cli-lockhome-"));
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  mkdirSync(join(home, ".omp"), { recursive: true });
  const holder = new Database(join(home, ".omp", "stats.db"));
  holder.exec("CREATE TABLE IF NOT EXISTS t(x); BEGIN IMMEDIATE");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = await cli(["doctor", "--workdir", "/tmp"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL databases");
    expect(r.out).toContain("database is locked");
  } finally {
    process.env.HOME = originalHome;
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("help exits 0 and an unknown command exits 2 with usage", async () => {
  expect((await cli(["help"])).code).toBe(0);
  const bad = await cli(["frobnicate"]);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("usage: dispatch");
});

test("a settled run's result.json carries everything a disk reader needs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "omp-cli-work-"));
  await cli(["start", "--prompt", "go", "--name", "ondisk", "--workdir", workdir]);
  const run = listRuns(workdir)[0]!;
  const raw = readFileSync(join(run.dir, "result.json"), "utf8");
  expect(raw).toContain("\"name\": \"ondisk\"");
  expect(raw).toContain("\"stopped_because\": \"completed\"");
  expect(existsSync(join(run.dir, "progress.log"))).toBe(true);
});
