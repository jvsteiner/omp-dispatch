import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export type RunState = "running" | "asking" | "completed" | "capped" | "aborted" | "error";
export type StoppedBecause =
  | "completed" | "max_turns" | "max_usd" | "max_seconds"
  | "aborted" | "error" | "asking" | null;

export interface RunResult {
  run_id: string;
  state: RunState;
  stopped_because: StoppedBecause;
  turns: number;
  tool_calls: number;
  cost_usd: number;
  seconds: number;
  model: { provider: string; id: string } | null;
  session_file: string | null;
  files_changed: string[];
  last_reply: string | null;
  ask: { ask_id: string; question: string; context?: string } | null;
}

let counter = 0;

/** Sorts chronologically as a plain string; the counter breaks same-millisecond ties. */
export function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // Padded to 6 base-36 digits (36^6 > 2.1 billion) so the counter can never grow
  // enough within a process's lifetime to overflow the width and break string sort order.
  return `${t}-${(counter++).toString(36).padStart(6, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export const runsRoot = (workdir: string) => join(workdir, ".omp-dispatch", "runs");
export const runDirFor = (workdir: string, runId: string) => join(runsRoot(workdir), runId);

export function createRunDir(workdir: string, runId: string): string {
  const dir = runDirFor(workdir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function emptyResult(runId: string): RunResult {
  return {
    run_id: runId, state: "running", stopped_because: null,
    turns: 0, tool_calls: 0, cost_usd: 0, seconds: 0,
    model: null, session_file: null, files_changed: [], last_reply: null, ask: null,
  };
}

export function writeResult(runDir: string, r: RunResult): void {
  // Write-then-rename so a reader never sees a half-written file. The temp name is
  // unique per call (pid + random suffix) so concurrent writers in the same run
  // directory can't interleave into a shared temp file before either renames.
  const tmp = join(runDir, `result.json.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  renameSync(tmp, join(runDir, "result.json"));
}

export function readResult(runDir: string): RunResult {
  return JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as RunResult;
}

export function isAlive(runDir: string): boolean {
  const pidFile = join(runDir, "broker.pid");
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but isn't ours to signal - it's alive.
    // ESRCH (and anything else) means no such process - it's dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function listRuns(workdir: string) {
  const root = runsRoot(workdir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort().reverse()                       // run ids sort chronologically
    .filter(id => existsSync(join(root, id, "result.json")))
    .map(id => {
      const dir = join(root, id);
      // Isolate one run's unreadable result.json from the rest of the listing -
      // result.json is the only thing the supervisor trusts, so a single malformed
      // file must not take down every other run's visibility.
      let result: RunResult;
      let readable = true;
      try {
        result = readResult(dir);
      } catch {
        readable = false;
        result = { ...emptyResult(id), state: "error" };
      }
      return { runId: id, dir, result, alive: isAlive(dir), readable };
    });
}

export function appendProgress(runDir: string, line: string): void {
  // Elapsed time is seeded from the run directory's own creation time, not a
  // module-level start time - a broker restart must not reset the clock, since
  // the log exists to let a human tell a long run from a hung one.
  const startedAt = statSync(runDir).birthtimeMs;
  const secs = Math.round((Date.now() - startedAt) / 1000);
  appendFileSync(join(runDir, "progress.log"), `[${String(secs).padStart(4)}s] ${line}\n`);
}
