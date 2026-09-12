import { test, expect } from "bun:test";
import {
  mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId, createRunDir, writeResult, readResult, emptyResult,
  listRuns, isAlive, appendProgress, runDirFor, runsRoot, pruneRuns,
} from "../src/rundir.ts";

const wd = () => mkdtempSync(join(tmpdir(), "omp-run-"));

test("run ids are unique and sort chronologically", () => {
  const ids = [newRunId(), newRunId(), newRunId()];
  expect(new Set(ids).size).toBe(3);
  expect([...ids].sort()).toEqual(ids);
});

test("creates the run directory under the workdir", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  expect(dir).toBe(runDirFor(w, id));
  expect(existsSync(dir)).toBe(true);
});

test("result round-trips", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  const r = { ...emptyResult(id), turns: 7, cost_usd: 0.16, state: "completed" as const };
  writeResult(dir, r);
  expect(readResult(dir).turns).toBe(7);
  expect(readResult(dir).cost_usd).toBe(0.16);
});

test("a run with no pidfile is not alive", () => {
  const w = wd(); const id = newRunId();
  writeResult(createRunDir(w, id), emptyResult(id));
  expect(isAlive(runDirFor(w, id))).toBe(false);
});

test("a run whose pid is this process is alive", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  writeResult(dir, emptyResult(id));
  writeFileSync(join(dir, "broker.pid"), String(process.pid));
  expect(isAlive(dir)).toBe(true);
});

test("a run whose pid is dead is not alive", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  writeResult(dir, emptyResult(id));
  writeFileSync(join(dir, "broker.pid"), "999999");
  expect(isAlive(dir)).toBe(false);
});

test("listRuns returns newest first with liveness", () => {
  const w = wd();
  const a = newRunId(); const b = newRunId();
  writeResult(createRunDir(w, a), emptyResult(a));
  writeResult(createRunDir(w, b), emptyResult(b));
  const runs = listRuns(w);
  expect(runs.map(r => r.runId)).toEqual([b, a]);
  expect(runs[0]!.alive).toBe(false);
});

test("listRuns is empty for a workdir that never ran anything", () => {
  expect(listRuns(wd())).toEqual([]);
});

test("listRuns isolates a run whose result.json is corrupt", () => {
  const w = wd();
  const good = newRunId(); const bad = newRunId();
  writeResult(createRunDir(w, good), emptyResult(good));
  const badDir = createRunDir(w, bad);
  writeFileSync(join(badDir, "result.json"), "{ not valid json");

  const runs = listRuns(w);
  expect(runs.map(r => r.runId).sort()).toEqual([bad, good].sort());

  const badRun = runs.find(r => r.runId === bad)!;
  expect(badRun.readable).toBe(false);
  expect(badRun.result.state).toBe("error");

  const goodRun = runs.find(r => r.runId === good)!;
  expect(goodRun.readable).toBe(true);
  expect(goodRun.result.run_id).toBe(good);
});

test("isAlive treats EPERM (process exists, not ours) as alive", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  writeResult(dir, emptyResult(id));
  // pid 1 (init/launchd) always exists; a non-root signal to it is EPERM, not ESRCH.
  // (If tests run as root, kill(1, 0) simply succeeds - still alive either way.)
  writeFileSync(join(dir, "broker.pid"), "1");
  expect(isAlive(dir)).toBe(true);
});

test("progress lines are appended with an elapsed prefix", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  appendProgress(dir, "read foo.md");
  appendProgress(dir, "write bar.md");
  const log = readFileSync(join(dir, "progress.log"), "utf8");
  expect(log.split("\n").filter(Boolean).length).toBe(2);
  expect(log).toContain("read foo.md");
});

test("elapsed time reflects the run directory's age, not the first call", async () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  await new Promise(resolve => setTimeout(resolve, 1100));
  // First-ever call for this dir: a "reset on first call" implementation would log ~0s.
  appendProgress(dir, "late first call");
  const log = readFileSync(join(dir, "progress.log"), "utf8");
  const elapsed = Number(/\[\s*(\d+)s\]/.exec(log)![1]);
  expect(elapsed).toBeGreaterThanOrEqual(1);
});

// --- run state must not land in the user's repository ---------------------

test("runsRoot is outside the workdir entirely", () => {
  const workdir = "/Users/someone/Code/their-project";
  const root = runsRoot(workdir);
  expect(root.startsWith(workdir)).toBe(false);
  expect(root).toContain(".omp-dispatch");
});

test("runs are grouped under a readable slug of the project", () => {
  expect(runsRoot("/a/b/their-project")).toContain("their-project-");
});

test("two projects with the same basename do not collide", () => {
  expect(runsRoot("/one/shared-name")).not.toBe(runsRoot("/two/shared-name"));
});

test("the same workdir always maps to the same root", () => {
  expect(runsRoot("/a/b/proj")).toBe(runsRoot("/a/b/proj"));
});

test("a workdir with awkward characters still yields a usable path", () => {
  const root = runsRoot("/a/b/my project (v2)!");
  expect(root).not.toContain(" ");
  expect(root).not.toContain("(");
});

test("creating a run directory leaves the workdir untouched", () => {
  const w = mkdtempSync(join(tmpdir(), "omp-clean-"));
  createRunDir(w, newRunId());
  expect(readdirSync(w)).toEqual([]);
});

// --- pruning: run state must not grow without limit ------------------------

function agedRun(root: string, project: string, runId: string, ageDays: number): string {
  const dir = join(root, project, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), "x".repeat(1024));
  const when = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(dir, when, when);
  return dir;
}

test("pruning removes nothing when there is nothing to remove", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  expect(pruneRuns(root).removed).toBe(0);
});

test("pruning a root that does not exist is not an error", () => {
  expect(pruneRuns(join(tmpdir(), "omp-prune-absent-" + Math.random())).removed).toBe(0);
});

test("a recent run is kept", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  const dir = agedRun(root, "proj", "20260912T000000Z-aaa", 0);
  pruneRuns(root);
  expect(existsSync(dir)).toBe(true);
});

test("runs beyond the per-project count are removed, newest kept", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  const dirs: string[] = [];
  for (let i = 0; i < 55; i++) {
    dirs.push(agedRun(root, "proj", `2026091${String(i).padStart(6, "0")}Z-x`, 0));
  }
  const { removed } = pruneRuns(root);
  expect(removed).toBe(5);
  expect(existsSync(dirs[dirs.length - 1]!)).toBe(true);   // newest survives
  expect(existsSync(dirs[0]!)).toBe(false);                 // oldest goes
});

test("pruning reports how much it freed", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  for (let i = 0; i < 52; i++) {
    agedRun(root, "proj", `2026091${String(i).padStart(6, "0")}Z-x`, 0);
  }
  expect(pruneRuns(root).freedBytes).toBeGreaterThan(1000);
});

test("one project's runs do not count against another's", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  const a = agedRun(root, "alpha", "20260912T000000Z-a", 0);
  const b = agedRun(root, "beta", "20260912T000000Z-b", 0);
  pruneRuns(root);
  expect(existsSync(a)).toBe(true);
  expect(existsSync(b)).toBe(true);
});

test("a run older than the age limit is removed even when the count is fine", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  const old = agedRun(root, "proj", "20260101T000000Z-old", 30);
  const fresh = agedRun(root, "proj", "20260912T000000Z-new", 0);
  const { removed } = pruneRuns(root);
  expect(removed).toBe(1);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test("a run just inside the age limit survives", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prune-"));
  const dir = agedRun(root, "proj", "20260910T000000Z-edge", 6);
  pruneRuns(root);
  expect(existsSync(dir)).toBe(true);
});
