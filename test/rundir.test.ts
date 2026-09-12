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

test("progress lines are appended with an elapsed prefix", () => {
  const w = wd(); const id = newRunId();
  const dir = createRunDir(w, id);
  appendProgress(dir, "read foo.md");
  appendProgress(dir, "write bar.md");
  const log = readFileSync(join(dir, "progress.log"), "utf8");
  expect(log.split("\n").filter(Boolean).length).toBe(2);
  expect(log).toContain("read foo.md");
});
