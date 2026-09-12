import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId, createRunDir, writeResult, readResult, emptyResult,
  listRuns, isAlive, appendProgress, runDirFor,
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
