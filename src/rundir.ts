import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, renameSync,
  statSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export type RunState = "running" | "asking" | "completed" | "capped" | "aborted" | "error";
export type StoppedBecause =
  | "completed" | "max_turns" | "max_usd" | "max_seconds"
  | "aborted" | "error" | "no_response" | "asking" | null;

export interface RunResult {
  run_id: string;
  /** The dispatch-chosen name (MCP registry key or CLI name); null for old runs. */
  name: string | null;
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

/**
 * Run state lives OUTSIDE the repository being worked in.
 *
 * Writing it into the workdir meant every project a dispatch touched grew a
 * new untracked directory needing its own .gitignore entry — and `.omp/` is
 * not ignored either, so nesting under omp's own directory would only have
 * renamed the problem. omp keeps its sessions under ~/.omp/agent/sessions for
 * the same reason: a run is not project content.
 *
 * The workdir is slugged into the path so runs stay grouped by project and
 * remain findable by eye, and hashed so two projects with the same basename
 * cannot collide.
 */
export function runsRoot(workdir: string): string {
  const base = workdir.replace(/\/+$/, "").split("/").pop() || "root";
  const slug = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  return join(process.env.HOME ?? homedir(), ".omp-dispatch", "runs", `${slug}-${hash}`);
}
export const runDirFor = (workdir: string, runId: string) => join(runsRoot(workdir), runId);

export function createRunDir(workdir: string, runId: string): string {
  const dir = runDirFor(workdir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface DiskRun {
  name: string;
  runId: string;
  dir: string;
  result: RunResult;
}

/**
 * Every named run on disk, across all project roots — the survival surface
 * after an MCP server restart or a CLI-started run. The in-memory registry
 * dies with the server; result.json does not. Newest wins per name (run ids
 * sort chronologically), and one unreadable run never hides the rest.
 */
export function findDiskRuns(): DiskRun[] {
  const root = join(process.env.HOME ?? homedir(), ".omp-dispatch", "runs");
  if (!existsSync(root)) return [];
  const byName = new Map<string, DiskRun>();
  for (const project of readdirSync(root)) {
    const pdir = join(root, project);
    let ids: string[];
    try {
      ids = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const id of ids.sort().reverse()) {
      const dir = join(pdir, id);
      try {
        const result = readResult(dir);
        if (result.name && !byName.has(result.name)) {
          byName.set(result.name, { name: result.name, runId: id, dir, result });
        }
      } catch {
        /* unreadable result.json: skip this run, keep the rest visible */
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function emptyResult(runId: string): RunResult {
  return {
    run_id: runId, name: null, state: "running", stopped_because: null,
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

export interface RunListing {
  runId: string;
  dir: string;
  result: RunResult;
  alive: boolean;
  readable: boolean;
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

/**
 * The git diff of what a run changed, written next to result.json so a
 * supervisor can review the work without running git (or spending an
 * approval) itself. Bounded: a generated-file landslide must not turn every
 * run directory into megabytes.
 */
const DIFF_LIMIT = 256 * 1024;

export function writeDiff(runDir: string, patch: string): void {
  if (!patch) return;
  const bounded = patch.length > DIFF_LIMIT
    ? patch.slice(0, DIFF_LIMIT) + "\n[diff truncated at 256KB]\n"
    : patch;
  writeFileSync(join(runDir, "diff.patch"), bounded);
}

/** The run's diff.patch, or null when the run changed nothing (or never wrote one). */
export function readDiff(runDir: string): string | null {
  try {
    return readFileSync(join(runDir, "diff.patch"), "utf8");
  } catch {
    return null;
  }
}

/**
 * How long a finished run's directory is kept, and how many are kept per
 * project regardless of age. Both bounds matter: the age rule alone lets a
 * heavy day fill a disk, and the count rule alone keeps ancient runs around on
 * a project touched once a month.
 *
 * A run costs roughly 60KB with frame tracing off, which is the default. With
 * OMP_DISPATCH_TRACE=1 it is nearer 400KB, nearly all of it events.jsonl.
 */
const KEEP_DAYS = 7;
const KEEP_PER_PROJECT = 50;

/**
 * Delete run directories that are past either bound. Called once when the MCP
 * server starts, so state cannot grow without limit across sessions.
 *
 * Best-effort by design: a directory that cannot be read or removed is skipped
 * rather than failing the server's startup. Returns what it removed so a caller
 * can report it.
 */
export function pruneRuns(
  root = join(process.env.HOME ?? homedir(), ".omp-dispatch", "runs"),
  now = Date.now(),
): { removed: number; freedBytes: number } {
  let removed = 0;
  let freedBytes = 0;
  if (!existsSync(root)) return { removed, freedBytes };

  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return { removed, freedBytes };
  }

  for (const project of projects) {
    const dir = join(root, project);
    let runs: string[];
    try {
      runs = readdirSync(dir).sort().reverse();   // run ids sort chronologically
    } catch {
      continue;
    }
    runs.forEach((runId, index) => {
      const path = join(dir, runId);
      let tooOld = false;
      try {
        // mtime, not birthtime: it measures age since the run last wrote
        // anything, which is the thing that matters, and unlike birthtime it
        // can be set in a test — an age rule nothing can exercise is an age
        // rule nobody knows works.
        tooOld = statSync(path).mtimeMs < cutoff;
      } catch {
        return;
      }
      if (!tooOld && index < KEEP_PER_PROJECT) return;
      try {
        freedBytes += dirSize(path);
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      } catch { /* skip anything we cannot remove */ }
    });
  }
  return { removed, freedBytes };
}

function dirSize(path: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      total += entry.isDirectory() ? dirSize(child) : statSync(child).size;
    }
  } catch { /* a file that vanished mid-walk is not worth failing over */ }
  return total;
}
