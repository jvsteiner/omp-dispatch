import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProviderKeys } from "./env.ts";
import { startRun } from "./runner.ts";
import {
  newRunId, createRunDir, listRuns, readResult, readDiff,
  type RunResult, type RunListing,
} from "./rundir.ts";
import { createWorktree, type Worktree } from "./worktree.ts";
import { runDiagnostics } from "./doctor.ts";
import {
  AGENT_DEFAULTS, capsFor, resolveAgentDef, resolveDispatchModel, resultFooter,
} from "./dispatch.ts";
import { uniqueName } from "./mcp/runs.ts";

/**
 * The dispatch CLI — the interface that survives an MCP outage. The server's
 * in-memory registry, steering and ask/answer flow are gone when the server
 * is, but runs themselves live on disk (result.json, progress.log,
 * diff.patch), and this reads and writes exactly those. `dispatch start` runs
 * in the FOREGROUND: the CLI process is the run's monitor, which is also what
 * makes `dispatch stop` possible — it signals this process, whose handler
 * settles the run cleanly rather than orphaning it.
 *
 * Steering and answering stay MCP-only; they need a live RPC connection to
 * the agent, and pretending otherwise is how the v1 broker happened.
 */
export interface CliOptions {
  /**
   * Overrides the agent launcher, same contract as CreateServerOptions.command
   * — a constructor seam, never an env var. Tests point it at fake-omp.
   */
  command?: string[];
  /** Injection for tests; production writes to the real streams. */
  out?: (s: string) => void;
  err?: (s: string) => void;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = "";
    }
  }
  return { positionals, flags };
}

const SETTLED: Record<string, true> = {
  completed: true, capped: true, aborted: true, error: true,
};

function usageText(): string {
  return [
    "usage: dispatch <command> [options]",
    "",
    "  start      Dispatch a run and monitor it in the foreground.",
    "             --prompt <text> (required)  --description <text>",
    "             --model <tier|id>  --subagent-type <name>  --name <name>",
    "             --workdir <abs path>  --isolation <none|worktree>",
    "             --max-turns N  --max-usd F  --max-seconds S",
    "  output     Print a run's report (or progress while it runs).",
    "             <run-id prefix | name | latest>  --workdir <abs path>",
    "             --wait <seconds>  --lines N  --diff",
    "  list       List runs on disk for a workdir.  --workdir <abs path>",
    "  stop       Signal a CLI-started run's monitor to settle it as aborted.",
    "             <run-id prefix | name | latest>  --workdir <abs path>",
    "  usage      Totals across the runs on disk for a workdir.",
    "  doctor     Same checks as the omp_doctor tool.  --workdir <abs path>",
    "",
    "Run state lives under ~/.omp-dispatch/runs/<project>-<hash>/ keyed by the",
    "run's workdir — pass the same --workdir the run used. Kept worktrees list",
    "under the worktree's own path.",
  ].join("\n");
}

function die(err: (s: string) => void, message: string): number {
  err(`dispatch: ${message}\n`);
  return 1;
}

/** Finds one run by id prefix, exact name, or the newest run. */
function findRun(
  runs: RunListing[],
  ref: string,
): { runId: string; dir: string; result: RunResult } | undefined {
  if (ref === "latest") return runs[0];
  return runs.find(r =>
    r.runId === ref || r.runId.startsWith(ref) || (r.result.name ?? "") === ref);
}

async function cmdStart(argv: string[], opts: CliOptions): Promise<number> {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? (s => process.stdout.write(s));
  const err = opts.err ?? (s => process.stderr.write(s));
  const prompt = flags["prompt"];
  if (!prompt) return die(err, "start requires --prompt <text>");
  const baseWorkdir = resolve(flags["workdir"] ?? process.cwd());
  const home = process.env.HOME ?? "";
  const name = flags["name"] ?? uniqueName(flags["description"] ?? prompt, () => false);

  const def = flags["subagent-type"]
    ? resolveAgentDef(flags["subagent-type"], baseWorkdir, home)
    : undefined;
  const model = resolveDispatchModel(flags["model"], def, baseWorkdir, home);
  const caps = capsFor(def, {
    maxTurns: flags["max-turns"] ? Number(flags["max-turns"]) : undefined,
    maxUsd: flags["max-usd"] ? Number(flags["max-usd"]) : undefined,
    maxSeconds: flags["max-seconds"] ? Number(flags["max-seconds"]) : undefined,
  });

  let targetWorkdir = baseWorkdir;
  let worktree: Worktree | undefined;
  if (flags["isolation"] === "worktree") {
    worktree = await createWorktree(baseWorkdir, name);
    targetWorkdir = worktree.path;
  }

  const runId = newRunId();
  const runDir = createRunDir(targetWorkdir, runId);
  writeFileSync(join(runDir, "monitor.pid"), `${process.pid}\n`);

  err(
    `START name=${name} model=${model} max_turns=${caps.maxTurns} ` +
    `max_usd=${caps.maxUsd.toFixed(2)} max_seconds=${caps.maxSeconds}\n` +
    `run_id=${runId} run_dir=${runDir} workdir=${targetWorkdir}\n` +
    `stop with: dispatch stop ${runId} --workdir ${targetWorkdir}\n`,
  );

  const handle = await startRun(
    {
      prompt,
      name,
      model,
      workdir: targetWorkdir,
      tools: def ? def.ompTools.join(",") : AGENT_DEFAULTS.tools,
      systemPrompt: def?.systemPrompt,
      maxTurns: caps.maxTurns,
      maxUsd: caps.maxUsd,
      maxSeconds: caps.maxSeconds,
      env: loadProviderKeys(),
      command: opts.command,
    },
    runDir,
    runId,
  );

  // The CLI process is the monitor, so stopping the run IS stopping this
  // process — but through the handle, which unlocks paths and writes a
  // result, unlike a kill. A second signal means the user wants out NOW.
  let signaled = false;
  const onSignal = () => {
    if (signaled) process.exit(130);
    signaled = true;
    err("dispatch: signal received — settling the run as aborted...\n");
    void handle.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const result = await handle.settled;
    let isolationNote = "";
    if (worktree) {
      const { removed, path } = await worktree.cleanup();
      isolationNote = removed
        ? `\n[omp:${name}] worktree was clean and has been removed`
        : `\n[omp:${name}] worktree kept — the agent left work in ${path}`;
    }
    out((result.last_reply ?? "(no reply)") +
      resultFooter(name, result, { modelLabel: model, runDir }) + isolationNote + "\n");
    return result.state === "error" ? 1 : 0;
  } finally {
    rmSync(join(runDir, "monitor.pid"), { force: true });
    await handle.dispose();
  }
}

async function cmdOutput(argv: string[], opts: CliOptions): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const out = opts.out ?? (s => process.stdout.write(s));
  const err = opts.err ?? (s => process.stderr.write(s));
  const workdir = resolve(flags["workdir"] ?? process.cwd());
  const ref = positionals[0] ?? "latest";
  const runs = listRuns(workdir);
  const run = findRun(runs, ref);
  if (!run) {
    return die(err, `no run '${ref}' under ${workdir}` +
      (runs.length
        ? `. Known: ${runs.slice(0, 10).map(r => r.result.name ?? r.runId).join(", ")}`
        : ". No runs on disk for this workdir."));
  }

  // result.json is rewritten on every state change by the run's monitor (this
  // process or the MCP server), so a fresh read IS the wait loop's source of
  // truth — no liveness probe needed.
  let result = readResult(run.dir);
  const waitSeconds = Number(flags["wait"] ?? 0);
  if (!SETTLED[result.state] && waitSeconds > 0) {
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      result = readResult(run.dir);
      if (SETTLED[result.state]) break;
    }
  }

  if (SETTLED[result.state]) {
    const diff = readDiff(run.dir);
    out((result.last_reply ?? "(no reply)") +
      resultFooter(result.name ?? run.runId, result, { runDir: run.dir }) +
      (flags["diff"] !== undefined
        ? diff
          ? `\n\n--- diff (git-derived, vs run start) ---\n${diff}`
          : "\n\n(no file changes — no diff was written)"
        : "") + "\n");
    return 0;
  }

  const log = join(run.dir, "progress.log");
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  out(`run '${result.name ?? run.runId}': state=${result.state}` +
    (result.ask ? ` question=${JSON.stringify(result.ask)}` : "") + "\n" +
    (lines.length
      ? lines.slice(-(Number(flags["lines"] ?? 40))).join("\n")
      : "No progress log yet.") + "\n");
  return 0;
}

async function cmdList(argv: string[], opts: CliOptions): Promise<number> {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? (s => process.stdout.write(s));
  const runs = listRuns(resolve(flags["workdir"] ?? process.cwd()));
  if (runs.length === 0) {
    out("No runs on disk for this workdir.\n");
    return 0;
  }
  out(runs.map(r =>
    `${r.runId}  ${r.result.name ?? "-"}  ${r.result.state.padEnd(9)} ` +
    `turns=${r.result.turns} cost_usd=${r.result.cost_usd.toFixed(4)} ` +
    `${r.result.stopped_because ?? ""}`.trimEnd(),
  ).join("\n") + "\n");
  return 0;
}

async function cmdStop(argv: string[], opts: CliOptions): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const out = opts.out ?? (s => process.stdout.write(s));
  const err = opts.err ?? (s => process.stderr.write(s));
  const workdir = resolve(flags["workdir"] ?? process.cwd());
  const ref = positionals[0];
  if (!ref) return die(err, "stop requires a run reference (id prefix, name, or latest)");
  const runs = listRuns(workdir);
  const run = findRun(runs, ref);
  if (!run) return die(err, `no run '${ref}' under ${workdir}`);

  const pidFile = join(run.dir, "monitor.pid");
  if (!existsSync(pidFile)) {
    return die(err,
      `run '${run.result.name ?? run.runId}' has no monitor on disk — only runs started ` +
      `by \`dispatch start\` can be stopped this way. A run owned by the MCP server ` +
      `is stopped with omp_task_stop.`);
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  // Confirm the pid still belongs to a dispatch monitor before signaling it:
  // pids are recycled, and SIGTERM to an unrelated recycled process is not a
  // theoretical failure.
  const ps = await Bun.$`ps -p ${pid} -o command=`.nothrow().quiet().text();
  if (!ps.includes("dispatch") && !ps.includes("cli.ts")) {
    return die(err, `pid ${pid} recorded in ${pidFile} is no longer a dispatch monitor — the run has already ended.`);
  }
  process.kill(pid, "SIGTERM");
  out(`signaled monitor ${pid}; the run settles as aborted and its result lands in ${run.dir}/result.json\n`);
  return 0;
}

async function cmdUsage(argv: string[], opts: CliOptions): Promise<number> {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? (s => process.stdout.write(s));
  const workdir = resolve(flags["workdir"] ?? process.cwd());
  const runs = listRuns(workdir);
  if (runs.length === 0) {
    out("No runs on disk for this workdir.\n");
    return 0;
  }
  const by: Record<string, number> = {};
  let turns = 0, toolCalls = 0, cost = 0, seconds = 0;
  for (const r of runs) {
    by[r.result.state] = (by[r.result.state] ?? 0) + 1;
    turns += r.result.turns;
    toolCalls += r.result.tool_calls;
    cost += r.result.cost_usd;
    seconds += r.result.seconds;
  }
  const outcomes = ["completed", "capped", "aborted", "error", "running", "asking"]
    .map(s => `${s}=${by[s] ?? 0}`).join(" ");
  out(
    `dispatched usage for ${workdir} (runs on disk: ${runs.length}): runs=${runs.length} (${outcomes})\n` +
    `turns=${turns} tool_calls=${toolCalls} cost_usd=${cost.toFixed(4)} wall_seconds=${seconds}\n`,
  );
  return 0;
}

async function cmdDoctor(argv: string[], opts: CliOptions): Promise<number> {
  const { flags } = parseArgs(argv);
  const out = opts.out ?? (s => process.stdout.write(s));
  const report = await runDiagnostics(resolve(flags["workdir"] ?? process.cwd()));
  out(report.text + "\n");
  return report.ok ? 0 : 1;
}

export async function runCli(argv: string[], opts: CliOptions = {}): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  const handlers: Record<string, (a: string[], o: CliOptions) => Promise<number>> = {
    start: cmdStart, output: cmdOutput, list: cmdList,
    stop: cmdStop, usage: cmdUsage, doctor: cmdDoctor,
  };
  const handler = handlers[command ?? ""];
  if (handler) {
    try {
      return await handler(rest, opts);
    } catch (e) {
      // Refusals (unknown definition, bad config, worktree failure) are the
      // interface, not crashes: same words as the MCP tool's error path,
      // delivered as exit 1 + stderr instead of a thrown exception.
      (opts.err ?? (s => process.stderr.write(s)))(
        `dispatch: ${e instanceof Error ? e.message : e}\n`,
      );
      return 1;
    }
  }
  (opts.err ?? (s => process.stderr.write(s)))(usageText() + "\n");
  return command === "help" || command === "--help" ? 0 : 2;
}
