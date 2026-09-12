import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, renameSync,
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
  return `${t}-${(counter++).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;
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
  // Write-then-rename so a reader never sees a half-written file.
  const tmp = join(runDir, "result.json.tmp");
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
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function listRuns(workdir: string) {
  const root = runsRoot(workdir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort().reverse()                       // run ids sort chronologically
    .filter(id => existsSync(join(root, id, "result.json")))
    .map(id => {
      const dir = join(root, id);
      return { runId: id, dir, result: readResult(dir), alive: isAlive(dir) };
    });
}

const started = new Map<string, number>();

export function appendProgress(runDir: string, line: string): void {
  if (!started.has(runDir)) started.set(runDir, Date.now());
  const secs = Math.round((Date.now() - started.get(runDir)!) / 1000);
  appendFileSync(join(runDir, "progress.log"), `[${String(secs).padStart(4)}s] ${line}\n`);
}
