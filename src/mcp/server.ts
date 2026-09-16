import { z } from "zod";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadProviderKeys } from "../env.ts";
import { ensureUserConfig, loadTierConfig } from "../models.ts";
import { startRun } from "../runner.ts";
import {
  AGENT_DEFAULTS, capsFor, DEFAULT_REPORTING_PROMPT, pluginVersion, resolveAgentDef,
  resolveDispatchModel, resultFooter, runningStatus,
} from "../dispatch.ts";
import { runDiagnostics } from "../doctor.ts";
import { readDiff } from "../rundir.ts";
import type { AgentDef } from "../agentdef.ts";
import { newRunId, createRunDir, pruneRuns, findDiskRuns, writeResult, type DiskRun } from "../rundir.ts";
import { createRegistry, uniqueName, type RunRegistry } from "./runs.ts";
import { createWorktree, type Worktree } from "../worktree.ts";

/**
 * Shell out to `omp` and return its stdout, trimmed. Every tool that talks to
 * omp goes through here so the leak guard and error shape stay in one place
 * as more tools are added.
 *
 * .quiet() stops the child's stdout/stderr from leaking onto our own — this
 * server talks JSON-RPC over stdout, so nothing else may write there.
 */
async function runOmp(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const result = await Bun.$`omp ${args}`
    .env({ ...process.env, ...extraEnv })
    .nothrow()
    .quiet();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `'omp ${args.join(" ")}' did not run successfully (exit code ${result.exitCode}).` +
        (stderr ? ` ${stderr}` : " Check that omp is installed and on PATH."),
    );
  }
  return result.stdout.toString().trim();
}


/**
 * omp_agent's `model` parameter is an enum of exactly the user's configured
 * tier names — the palette both hosts' callers already know how to pick from
 * (Claude Code's haiku/sonnet/opus/fable, Codex's gpt-5.6-luna/terra and
 * gpt-6-astra, plus custom tiers). A constrained choice is the whole point:
 * the caller keeps its native pick-by-job reflex and has no vendor model,
 * price list or catalogue to deliberate over. Raw model ids are the CLI's
 * power path; a user who wants one exposed here adds it as a tier
 * (`"deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro"`).
 *
 * Read once at server start from the user-level config only — a per-project
 * config may remap palette entries and the default, but names invented only
 * in a project config cannot appear in a schema built before any workdir is
 * known. Add shared tier names to ~/.omp-dispatch/config.json.
 */
function modelPaletteSchema(home: string) {
  // The server's first start is a fresh install's first moment (plugin
  // installs run no scripts), so this is where the editable config comes
  // into being — with the shipped palette, only if absent.
  ensureUserConfig(home);
  const cfg = loadTierConfig([join(home, ".omp-dispatch", "config.json")]);
  const names = Object.keys(cfg.tiers).sort();
  return z.enum(names as [string, ...string[]]).optional().describe(
    "Pick by job exactly as you would natively — each name is a tier the user mapped " +
    "to a model they chose, so cost and preference are already handled; never " +
    `deliberate over it. Omit to run on the user's default tier ('${cfg.default}'). ` +
    `Palette: ${names.join(", ")}.`,
  );
}

export interface CreateServerOptions {
  /**
   * Overrides the agent launcher every omp_agent dispatch uses, passed
   * straight through to RunOptions.command (see src/runner.ts). Tests point
   * this at test/fake-omp.ts; production leaves it unset so startRun() falls
   * back to the real omp CLI. There is deliberately no env-var equivalent:
   * an env var here would let anything that seeds session environment
   * (a project settings block, direnv) silently redirect every dispatch to
   * an arbitrary argv, with provider API keys merged into its environment —
   * this constructor argument is the one seam that can't be hit that way.
   */
  command?: string[];

  /**
   * Supplies the run registry instead of creating a fresh one. Lets
   * runStdioServer() below hold the exact same registry a SIGTERM/SIGINT/
   * stdin-end handler must dispose directly — see the comment there for why
   * the onclose hook wired below is not enough on its own in production.
   * Tests never pass this; every InMemoryTransport-based server gets its own
   * registry via the default.
   */
  registry?: RunRegistry;
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
  // Read, not hardcoded: a literal here silently goes stale on every release,
  // so the server would tell clients it is a version that is no longer what is
  // installed. Caught when 0.1.1 introduced itself as 0.1.0.
  const server = new McpServer({ name: "omp-dispatch", version: pluginVersion() });

  // Every dispatched run lives here, keyed by name, once it has settled — see
  // src/mcp/runs.ts. `reserved` closes the race a bare registry can't: two
  // concurrent dispatches with the same auto-generated name would otherwise
  // both see the name free, since nothing is added to the registry itself
  // until well after the run has settled. A name is reserved synchronously,
  // with no `await` in between, the instant it is chosen.
  const registry = opts.registry ?? createRegistry();
  const reserved = new Set<string>();
  const isTaken = (n: string) => registry.has(n) || reserved.has(n);
  type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  const operations = new Map<string, { done: Promise<Reply>; reply?: Reply; served?: boolean }>();
  // Catch failures even when no client is currently waiting. Keep the reply
  // (including worktree cleanup/errors) available to later polling calls.
  const track = (name: string, promise: Promise<Reply>) => {
    const operation: { done: Promise<Reply>; reply?: Reply; served?: boolean } = {
      done: promise.catch(e => ({
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      })),
    };
    operation.done = operation.done.then(reply => { operation.reply = reply; return reply; });
    operations.set(name, operation);
    return operation.done;
  };
  // Shared-workdir reservations taken synchronously at dispatch, closing the
  // race two concurrent omp_agent calls could otherwise slip through: the
  // guard check and this reservation happen with no `await` between them, so
  // a second dispatch cannot pass the check while a first is still between
  // check and registry.add. Cleared the moment the registry entry takes over
  // (or the dispatch fails) — see omp_agent.
  const pendingShared = new Map<string, string[]>();

  /**
   * How long a foreground omp_agent / omp_send_message may block before
   * returning a "still running" handoff instead of its result.
   *
   * The bound exists for one reason: a host that kills an in-flight MCP call
   * at its own timeout (Codex backgrounds the call, then re-delivers the full
   * result as a task notification — the supervisor pays for the same report
   * twice). Returning before the host can time the call out converts that
   * hard timeout into a graceful handoff to omp_task_output / omp_wait.
   * Codex's documented default is 60s, so the default bound sits just under
   * it; Claude Code's per-call budget is effectively unbounded and detected
   * by client name so it keeps true blocking. OMP_DISPATCH_BLOCK_MS overrides
   * everything, for hosts configured anywhere in between.
   */
  const hostBlockMs = () => {
    const env = Number(process.env.OMP_DISPATCH_BLOCK_MS);
    if (Number.isFinite(env) && env > 0) return env;
    const client = server.server.getClientVersion()?.name?.toLowerCase() ?? "";
    if (client.includes("claude")) return 86_400_000;
    return 55_000;
  };

  /**
   * In-flight runs still holding a shared workdir — the concurrency guard's
   * hit list. Only registry runs count: an on-disk "running" run belongs to a
   * server that died, and its agent died with it. Worktree-isolated runs
   * never count: their writes land in a private checkout, so they cannot
   * interleave with anything in the base workdir. Exact path match only — a
   * run in a subdirectory is a different workdir as far as this guard goes.
   */
  const busyInWorkdir = (workdir: string, exclude: string[]): string[] =>
    registry.list()
      .filter(({ name }) => !exclude.includes(name))
      .filter(({ handle }) =>
        (handle.result.state === "running" || handle.result.state === "asking") &&
        handle.result.worktree_base === null &&
        handle.result.workdir === workdir)
      .map(({ name, handle }) => `${name} (${handle.result.state})`);

  /**
   * Serve a settled operation's reply in full exactly once. Second and later
   * serves get a tombstone — footer plus pointers — because the report is
   * already in the caller's context and a re-fetch re-bills the same tokens
   * for zero new information. Error replies are never tombstoned: the doctor
   * output they carry is exactly what a caller re-checking a failure needs.
   */
  const serveReply = (name: string, operation: { reply?: Reply; served?: boolean }): Reply => {
    const reply = operation.reply!;
    if (reply.isError) return reply;
    if (operation.served) {
      const handle = registry.get(name);
      const footer = handle
        ? resultFooter(name, handle.result, { runDir: handle.runDir })
        : `\n\n---\n[omp:${name}]`;
      return { content: [{ type: "text", text:
        `[omp:${name}] report already delivered this session — not repeated.` + footer +
        (handle
          ? `\nFull report: ${join(handle.runDir, "result.json")} (last_reply). ` +
            `Diff: ${join(handle.runDir, "diff.patch")}, or omp_task_output with include_diff.`
          : ""),
      }] };
    }
    operation.served = true;
    return reply;
  };

  /**
   * A settled run's reply for omp_wait: the tracked operation's reply when
   * there is one (tombstone-aware), else built straight from the live result —
   * covering the window between registry.add and track() where a wait can
   * land. Only reachable for runs mustFind already resolved.
   */
  const collectSettled = (name: string): Reply => {
    const operation = operations.get(name);
    if (operation?.reply) return serveReply(name, operation);
    const handle = registry.get(name)!;
    const r = handle.result;
    if (r.state === "error") {
      return { isError: true, content: [{ type: "text", text:
        `run '${name}' did not complete: ${r.stopped_because}. See ${handle.runDir}/progress.log for details.` }] };
    }
    return { content: [{ type: "text", text:
      (r.last_reply ?? "(no reply)") + resultFooter(name, r, { runDir: handle.runDir }) }] };
  };

  // The one live-status line shared by omp_task_output and omp_wait, carrying
  // everything the handle knows that a disk read cannot: liveness age and the
  // wall-clock budget.
  const liveStatus = (name: string): string => {
    const handle = registry.get(name)!;
    return runningStatus(name, handle.result, handle.runDir, {
      maxSeconds: handle.maxSeconds,
      lastFrame: handle.lastFrame,
    });
  };


  // Every successful dispatch's omp process is `detached: true` (see
  // runner.ts) and deliberately outlives the run that started it, so a later
  // omp_send_message can resume it. Nothing else reaps those processes, so
  // this disposes the registry when the transport actually closes —
  // reliable under InMemoryTransport (every test in this file but one), but
  // NOT under the production StdioServerTransport: the SDK's server/stdio.js
  // registers no 'end'/'close' listener on stdin and this process installs
  // no SIGTERM/SIGINT handler of its own, so transport.close() (onclose's
  // only caller) never runs on a real shutdown. runStdioServer() below is
  // what actually covers that gap, directly against the same `registry` via
  // the option above — onclose alone cannot, no matter what it's wired to.
  server.server.onclose = () => {
    void registry.disposeAll();
  };

  server.tool(
    "omp_agent",
    "Spawn an omp subagent on the user's configured models to run a task end to end, in " +
      "place of a native subagent. Set run_in_background to return right after startup. " +
      "Otherwise the call blocks until the run settles or a host-safe bound (~55s; override " +
      "with OMP_DISPATCH_BLOCK_MS; effectively unbounded on Claude Code) elapses — a long run " +
      "hands off to omp_task_output instead of letting the host time the call out. A cap " +
      "breach (max turns or max spend) is reported in that footer, not thrown. One shared " +
      "workdir holds one in-flight run: a concurrent dispatch there is refused until you " +
      "pass isolation: \"worktree\".",
    {
      description: z.string().describe("A short (3-5 word) description of the task"),
      prompt: z.string().describe("The task for the agent to perform"),
      subagent_type: z.string().optional().describe(
        "Name of a Markdown agent definition in .omp-dispatch/agents or .claude/agents " +
          "under the project or home directory. Its tools, system prompt, maxTurns and model " +
          "are applied. A definition requiring a tool omp has no equivalent for (Skill, " +
          "ToolSearch, an mcp__* tool) is refused rather than run weakened. Omit to run " +
          "with the defaults.",
      ),
      model: modelPaletteSchema(process.env.HOME ?? ""),
      name: z.string().optional().describe(
        "A name for this run, for use later with omp_send_message. Auto-generated from " +
          "description when omitted. An explicit name already in use is an error naming " +
          "the run that already has it — it is never silently suffixed.",
      ),
      isolation: z.enum(["none", "worktree"]).optional().describe(
        "'none' (default) runs in workdir, like a native subagent — and is refused while " +
          "another in-flight run already holds that workdir. 'worktree' gives the run its " +
          "own git checkout so it can write freely without touching your working tree — " +
          "the same guarantee Agent's isolation: \"worktree\" offers, and the way to run " +
          "agents concurrently in one repo. An unchanged worktree is cleaned up; one the " +
          "agent left work in is kept and its path reported.",
      ),
      workdir: z.string().optional().describe(
        "Absolute path the agent runs in. Defaults to this MCP server process's own " +
          "working directory.",
      ),
      run_in_background: z.boolean().optional().describe(
        "Return the run name, resolved model and caps after startup; collect the report " +
          "with omp_task_output or omp_wait. Recommended for Codex.",
      ),
    },
    async ({ description, prompt, subagent_type, model, name, isolation, workdir, run_in_background }, extra) => {
      const baseWorkdir = workdir ?? process.cwd();
      let targetWorkdir = baseWorkdir;

      // Resolved BEFORE any run starts, so a refusal costs nothing. The
      // refusal texts live in src/dispatch.ts, shared verbatim with the CLI.
      const def: AgentDef | undefined = subagent_type
        ? resolveAgentDef(subagent_type, targetWorkdir, process.env.HOME ?? "")
        : undefined;
      // Fail-closed concurrency guard: two agents interleaving writes (and
      // commits) in one shared workdir corrupt each other's verification —
      // the docs agent that reads the implementer's half-written tree is the
      // canonical failure. The cheaper failure mode is a refusal naming the
      // run already holding the directory. Worktree dispatches are exempt:
      // their writes cannot reach the base workdir. Before name selection,
      // so a refusal leaks no reservation.
      if (isolation !== "worktree") {
        const busy = [
          ...(pendingShared.get(baseWorkdir) ?? []).map(n => `${n} (starting)`),
          ...busyInWorkdir(baseWorkdir, []),
        ];
        if (busy.length > 0) {
          throw new Error(
            `omp_agent: workdir ${baseWorkdir} is busy with in-flight run(s) ${busy.join(", ")}. ` +
              `Dispatch with isolation: "worktree" for a private checkout of the same repo, or ` +
              `collect (omp_task_output / omp_wait) or stop (omp_task_stop) the busy run(s) first.`,
          );
        }
      }


      let runName: string;
      if (name) {
        if (isTaken(name)) {
          const existing = registry.get(name);
          throw new Error(
            `omp_agent: the name '${name}' is already in use` +
              (existing ? ` by run ${existing.runId}` : "") +
              ` — choose a different name, or use omp_send_message to continue that run.`,
          );
        }
        runName = name;
      } else {
        runName = uniqueName(description, isTaken);
      }
      reserved.add(runName);
      // The other half of the guard, still synchronous with the check above:
      // reserved this workdir for runName before the first await below.
      if (isolation !== "worktree") {
        pendingShared.set(baseWorkdir, [...(pendingShared.get(baseWorkdir) ?? []), runName]);
      }


      let progressTimer: ReturnType<typeof setInterval> | undefined;
      let worktree: Worktree | undefined;
      try {
        // After the agent-definition checks above, so a refusal never leaves a
        // worktree behind, and before the run, so it is what the agent runs in.
        if (isolation === "worktree") {
          worktree = await createWorktree(baseWorkdir, runName);
          targetWorkdir = worktree.path;
        }
        const home = process.env.HOME ?? "";
        const resolvedModel = resolveDispatchModel(model, def, targetWorkdir, home);
        const caps = capsFor(def);

        const runId = newRunId();
        const runDir = createRunDir(targetWorkdir, runId);

        // loadProviderKeys() must land in the child's env or its catalogue
        // is missing every provider whose key lives only in a shell rc file
        // — see src/env.ts.
        const handle = await startRun(
          {
            prompt,
            name: runName,
            model: resolvedModel,
            workdir: targetWorkdir,
            tools: def ? def.ompTools.join(",") : AGENT_DEFAULTS.tools,
            // Definition-less dispatches still run under the fire-and-forget
            // reporting contract — terse by default, not per-brief.
            systemPrompt: def?.systemPrompt ?? DEFAULT_REPORTING_PROMPT,
            maxTurns: caps.maxTurns,
            maxUsd: caps.maxUsd,
            maxSeconds: caps.maxSeconds,
            env: loadProviderKeys(),
            command: opts.command,
          },
          runDir,
          runId,
        );

        // Registered the moment the run exists, not once it settles: steering
        // it, tailing it or stopping it are only useful WHILE it is running,
        // and omp_agent blocks for the whole of that. The omp process
        // deliberately outlives the run so a later omp_send_message can
        // resume it, so dispose() is the registry's job from here on — except
        // on the error path below, which removes and disposes it.
        registry.add(runName, handle);
        // Recorded for the concurrency guard, omp_list_agents and disk
        // resumes: the directory this run actually works in, and the repo it
        // was isolated from (null when it shares the caller's workdir).
        handle.result.workdir = targetWorkdir;
        handle.result.worktree_base = worktree ? baseWorkdir : null;
        writeResult(runDir, handle.result);
        // The registry entry carries the guard from here; pendingShared's
        // synchronous reservation above only bridged check to registry.add.
        if (isolation !== "worktree") {
          pendingShared.set(baseWorkdir, (pendingShared.get(baseWorkdir) ?? []).filter(n => n !== runName));
        }


        // omp_agent blocks for as long as the run takes. Claude Code's own
        // per-call wall clock (MCP_TOOL_TIMEOUT) is generous — on the order
        // of 28 hours — and MCP_TIMEOUT's 30s only bounds server *startup*,
        // not a tool call in flight, so neither is what this guards against.
        // What actually needs resetting is stdio's own ~30-minute idle
        // timeout on the connection; a progress notification resets that on
        // any client that asked for one (resetTimeoutOnProgress plus a
        // progressToken in the request), so only sent when the caller
        // actually supplied a progressToken — nothing to reset otherwise.
        // Interval read per call, like OMP_DISPATCH_POLL_MS in runner.ts, so
        // a test can shrink it without a module-load-time freeze.
        const progressToken = extra._meta?.progressToken;
        if (progressToken !== undefined && !run_in_background) {
          const progressMs = Number(process.env.OMP_DISPATCH_PROGRESS_MS) || 15_000;
          let n = 0;
          progressTimer = setInterval(() => {
            n += 1;
            void extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: n,
                message: `run '${runName}': turns=${handle.result.turns} ` +
                  `cost_usd=${handle.result.cost_usd.toFixed(4)}`,
              },
            }).catch(() => {});
          }, progressMs);
        }

        const finish = async (): Promise<Reply> => {
          const result = await handle.settled;
          let isolationNote = "";
          if (worktree) {
            const { removed, path } = await worktree.cleanup();
            isolationNote = removed
              ? `\n[omp:${runName}] worktree was clean and has been removed`
              : `\n[omp:${runName}] worktree kept — the agent left work in ${path}`;
          }

          // A cap breach (max_turns/max_usd/max_seconds) is a result, not an
          // exception — the run's own report and footer say so via
          // stopped_because. Only a failure to start (or a mid-run failure the
          // runner could not recover from) reaches state "error", and that is
          // the one case this throws instead of returning a footer.
          if (result.state === "error") {
            // Failed children need disposal too. Background runs keep their
            // handle so list/output can still explain what failed.
            if (!run_in_background) registry.remove(runName);
            await handle.dispose();
            // Self-diagnosing failure: the doctor output rides along with
            // the error, so the caller learns WHAT to fix in the same
            // exchange instead of a second tool call (and, on a sandboxed
            // host, a second approval). Diagnostics must never mask the
            // failure it is explaining.
            let message =
              `omp_agent: run '${runName}' (${runId}) did not complete: ` +
              `${result.stopped_because ?? "error"}. See ${runDir}/progress.log for details.${isolationNote}`;
            try {
              message += `\n\n${(await runDiagnostics(baseWorkdir)).text}`;
            } catch { /* the failure itself is the message */ }
            throw new Error(message);
          }
          // The footer prefers RunResult.model — the agent's own reported
          // state, and the one field that can drift from what was asked for —
          // falling back to the resolved request string only when the run
          // ended before it could report one.
          const footer = resultFooter(runName, result, {
            modelLabel: resolvedModel, runDir,
            // A kept worktree's branch is what a supervisor merges; the base
            // names the repo it belongs to.
            ...(worktree ? { extra: {
              worktree_branch: `omp-dispatch/${runId}`,
              worktree_base: baseWorkdir,
            } } : {}),
          });

          return {
            content: [{ type: "text", text: (result.last_reply ?? "(no reply)") + footer + isolationNote }],
          };
        };
        const done = track(runName, finish());
        if (run_in_background) {
          return { content: [{ type: "text", text:
            `Started '${runName}' model=${model && model !== resolvedModel ? `${model}→${resolvedModel}` : resolvedModel} ` +
            `max_turns=${caps.maxTurns} max_usd=${caps.maxUsd.toFixed(2)} ` +
            `max_seconds=${caps.maxSeconds}.\n` +
            `Collect with omp_task_output({name: ${JSON.stringify(runName)}, wait_seconds: 50}) — it ` +
            `returns early the moment the run settles; keep the wait under your client's MCP call ` +
            `timeout. Waiting on several runs? omp_wait takes them all at once.\n` +
            `Run directory: ${runDir}\n` +
            `Wrong model? omp_task_stop({name: ${JSON.stringify(runName)}}) and dispatch again ` +
            `with another tier from the model palette.`,
          }] };
        }
        // Foreground, block-bounded (hostBlockMs): never let a host timeout
        // kill this call mid-flight. A run settling inside the bound returns
        // its full result inline; one that does not gets the same compact
        // handoff the background path returns, while the tracked operation
        // holds the real reply for omp_task_output / omp_wait.
        const blockMs = hostBlockMs();
        const bound = new Promise<null>(resolve => {
          const timer = setTimeout(() => resolve(null), blockMs);
          timer.unref?.();
        });
        const reply = await Promise.race([done, bound]);
        if (reply) {
          // Delivered inline: a later omp_task_output gets the tombstone,
          // not a second copy of the same report.
          if (!reply.isError) operations.get(runName)!.served = true;
          return reply;
        }
        return { content: [{ type: "text", text:
          `Still running '${runName}' (model=${resolvedModel}) after ${Math.round(blockMs / 1000)}s — ` +
          `this is a handoff, not an error, returned before your client's MCP call timeout could ` +
          `interrupt it. Collect with omp_task_output({name: ${JSON.stringify(runName)}, wait_seconds: 50}) ` +
          `— it returns early the moment the run settles — or omp_wait on several runs at once. ` +
          `Run directory: ${runDir}`,
        }] };
      } finally {
        clearInterval(progressTimer);
        reserved.delete(runName);
        // A dispatch that failed before registry.add must not leave its
        // workdir reserved forever. After the handover above this is a no-op.
        if (isolation !== "worktree") {
          pendingShared.set(baseWorkdir, (pendingShared.get(baseWorkdir) ?? []).filter(n => n !== runName));
        }
      }
    },
  );

  // --- conversation: the native-parity half of the surface -----------------
  //
  // Each of these names a run the way Agent's own companions do. A run that
  // cannot be found is always an error naming it AND listing what does exist:
  // the caller has just mistyped a name it will have to get right to continue,
  // and a bare "not found" makes it guess.

  // The registry dies with the server; result.json does not. Any run that
  // ever settled is still findable on disk, and — beyond reading — a
  // COMPLETED one can be resumed into a fresh omp process (see
  // omp_send_message), which is what makes a server restart survivable.
  const diskRun = (name: string): DiskRun | undefined =>
    findDiskRuns().find(d => d.name === name);

  const mustFind = (name: string, tool: string) => {
    const handle = registry.get(name);
    if (!handle) {
      const known = registry.list().map(r => r.name).sort();
      const onDisk = findDiskRuns()
        .filter(d => !known.includes(d.name))
        .map(d => d.name);
      throw new Error(
        `${tool}: no live run named '${name}'. ` +
          (known.length ? `Running or finished: ${known.join(", ")}.` : `No runs in this session.`) +
          (onDisk.length ? ` On disk (readable via omp_task_output; completed ones resumable via omp_send_message): ${onDisk.join(", ")}.` : ""),
      );
    }
    return handle;
  };

  // A settled run read from disk after a restart (or started by the CLI).
  // Live-only surfaces (steer, answer) stay live-only; this is reading and,
  // for completed runs, resuming.
  const diskReply = (disk: DiskRun, includeDiff: boolean): Reply => {
    const r = disk.result;
    const footer = resultFooter(disk.name, r, { runDir: disk.dir });
    const stale = r.state === "running"
      ? `\n(This run was in flight when its server went away — the agent process died with it. ` +
        `Its artifacts are readable; a completed run can be continued with omp_send_message.)`
      : `\n(on-disk run ${disk.runId} — server restarted or CLI-started. ` +
        `Completed on-disk runs continue with omp_send_message, passing the run's workdir.)`;
    const diff = includeDiff ? readDiff(disk.dir) : null;
    const diffText = includeDiff
      ? (diff ? `\n\n--- diff (git-derived, vs run start) ---\n${diff}` : "\n\n(no file changes — no diff was written)")
      : "";
    return { content: [{ type: "text", text: (r.last_reply ?? "(no reply)") + footer + stale + diffText }] };
  };

  server.tool(
    "omp_send_message",
    "Continue a run with a follow-up, keeping its context — the omp equivalent of " +
      "SendMessage. Works on a run that has already finished: it is resumed rather than " +
      "restarted — including an on-disk run from BEFORE a server restart, which is " +
      "resumed into a fresh agent with its session intact (pass the run's workdir). " +
      "A run that stopped for any other reason (a cap, an abort, an error) " +
      "refuses, naming the reason. Blocks until the new turn settles or the same " +
      "host-safe bound as omp_agent, then hands off to omp_task_output.",
    {
      to: z.string().describe("The run's name, as returned by omp_agent or omp_list_agents."),
      message: z.string().describe("The follow-up to send."),
      workdir: z.string().optional().describe(
        "Absolute project path. Required when resuming an on-disk run (run dirs are " +
        "hash-keyed, so the workdir cannot be recovered from the name alone).",
      ),
      run_in_background: z.boolean().optional().describe("Return immediately; collect with omp_task_output. Recommended for Codex."),
    },
    async ({ to, message, workdir, run_in_background }) => {
      if (operations.has(to) && !operations.get(to)!.reply) {
        throw new Error(`omp_send_message: run '${to}' is still active; use omp_steer or wait for its result.`);
      }
      let handle = registry.get(to);
      let resumedFromDisk = false;
      if (!handle) {
        const disk = diskRun(to);
        if (!disk) {
          // Throws with the full listing of what does exist.
          throw mustFind(to, "omp_send_message");
        }
        const r = disk.result;
        if (r.state !== "completed") {
          throw new Error(
            `omp_send_message: on-disk run '${to}' stopped because ${r.stopped_because ?? r.state} — ` +
            `only a completed run can be resumed.`,
          );
        }
        if (!r.session_file) {
          throw new Error(`omp_send_message: on-disk run '${to}' recorded no session file — cannot resume.`);
        }
        if (!workdir) {
          throw new Error(
            `omp_send_message: resuming on-disk run '${to}' requires its workdir — ` +
            `retry with workdir set to the absolute project path it ran in.`,
          );
        }
        // Same fail-closed rule as omp_agent: the resumed run re-enters this
        // workdir, so another in-flight run there is the same interleaving
        // hazard a fresh dispatch would be. Checked before startRun so a
        // refusal starts nothing.
        const busyDisk = busyInWorkdir(workdir, [to]);
        if (busyDisk.length > 0) {
          throw new Error(
            `omp_send_message: workdir ${workdir} is busy with in-flight run(s) ${busyDisk.join(", ")}. ` +
              `Collect or stop the busy run(s) first, or continue this one after they settle.`,
          );
        }

        if (isTaken(to)) {
          throw new Error(`omp_send_message: the name '${to}' is already in use.`);
        }
        reserved.add(to);
        try {
          // Same run directory, same name, same conversation: a fresh omp
          // process resumes the recorded session; caps re-arm fresh while
          // turns and cost stay cumulative (getSessionStats reads the resumed
          // session). The model is whatever the run itself last reported,
          // falling back to the default tier for ancient runs that recorded
          // none — RunOptions.model is a required string the runner splits on.
          const model = r.model
            ? `${r.model.provider}/${r.model.id}`
            : resolveDispatchModel(undefined, undefined, workdir, process.env.HOME ?? "");
          handle = await startRun(
            {
              prompt: message,
              name: to,
              model,

              workdir,
              tools: AGENT_DEFAULTS.tools,
              maxTurns: AGENT_DEFAULTS.maxTurns,
              maxUsd: AGENT_DEFAULTS.maxUsd,
              maxSeconds: AGENT_DEFAULTS.maxSeconds,
              env: loadProviderKeys(),
              command: opts.command,
              resumeSessionFile: r.session_file,
            },
            disk.dir,
            disk.runId,
          );
          registry.add(to, handle);
          resumedFromDisk = true;
        } finally {
          reserved.delete(to);
        }
      }
      const liveHandle = handle;
      // The live-run half of that guard. Runs recorded before workdir was
      // persisted have nothing to compare — skip rather than guess.
      if (liveHandle.result.workdir) {
        const busyLive = busyInWorkdir(liveHandle.result.workdir, [to]);
        if (busyLive.length > 0) {
          throw new Error(
            `omp_send_message: workdir ${liveHandle.result.workdir} is busy with in-flight ` +
              `run(s) ${busyLive.join(", ")}. Collect or stop the busy run(s) first, or continue ` +
              `this one after they settle.`,
          );
        }
      }

      const finish = async (): Promise<Reply> => {
        if (resumedFromDisk) {
          const r = await liveHandle.settled;
          if (r.state === "error") {
            throw new Error(
              `omp_send_message: resumed run '${to}' did not complete: ${r.stopped_because}. ` +
              `See ${liveHandle.runDir}/progress.log for details.`,
            );
          }
          const footer = resultFooter(to, r, { runDir: liveHandle.runDir });
          return { content: [{ type: "text", text: (r.last_reply ?? "(no reply)") + footer }] };
        }
        const reply = await liveHandle.say(message);
        const footer = resultFooter(to, liveHandle.result, { runDir: liveHandle.runDir });
        return { content: [{ type: "text", text: (reply || "(no reply)") + footer }] };
      };
      const done = track(to, finish());
      if (run_in_background) {
        return { content: [{ type: "text", text:
          resumedFromDisk
            ? `Resumed '${to}' from its saved session. Collect with omp_task_output.`
            : `Continuing '${to}'. Collect with omp_task_output.` }] };
      }
      // Same block bound as omp_agent's foreground path, for the same reason:
      // never let a host timeout interrupt a call whose result it would then
      // re-deliver as a duplicate.
      const blockMs = hostBlockMs();
      const bound = new Promise<null>(resolve => {
        const timer = setTimeout(() => resolve(null), blockMs);
        timer.unref?.();
      });
      const reply = await Promise.race([done, bound]);
      if (reply) {
        if (!reply.isError) operations.get(to)!.served = true;
        return reply;
      }
      return { content: [{ type: "text", text:
        `Still continuing '${to}' after ${Math.round(blockMs / 1000)}s — a handoff, not an error. ` +
        `Collect with omp_task_output({name: ${JSON.stringify(to)}, wait_seconds: 50}).`,
      }] };
    },
  );

  server.tool(
    "omp_steer",
    "Interrupt the turn a run is in the middle of with a correction. Use it when an " +
      "agent is going the wrong way. Returns as soon as the message is queued.",
    {
      to: z.string().describe("The run's name."),
      message: z.string().describe("The steering message."),
    },
    async ({ to, message }) => {
      await mustFind(to, "omp_steer").steer(message);
      return { content: [{ type: "text", text: `steered '${to}'` }] };
    },
  );

  server.tool(
    "omp_list_agents",
    "List every omp run this session has started, running or finished, with its state, " +
      "turns and cost so far. Settled runs from earlier sessions or CLI starts are " +
      "listed from disk, marked (on-disk): readable via omp_task_output, and completed " +
      "ones continuable via omp_send_message with their workdir.",
    {},
    async () => {
      const runs = registry.list();
      const lines = runs.map(({ name, handle }) => {
        const r = handle.result;
        return `${name}  ${r.state.padEnd(10)} turns=${r.turns} ` +
          `cost_usd=${r.cost_usd.toFixed(4)} ` +
          (r.worktree_base ? `worktree-of=${r.worktree_base}` : r.workdir ? `workdir=${r.workdir}` : "") +
          ` ${r.stopped_because ?? ""}`.trimEnd();
      });
      const liveNames = new Set(runs.map(r => r.name));
      const diskLines = findDiskRuns()
        .filter(d => !liveNames.has(d.name))
        .map(d =>
          `${d.name}  ${d.result.state.padEnd(10)} turns=${d.result.turns} ` +
          `cost_usd=${d.result.cost_usd.toFixed(4)} ` +
          (d.result.worktree_base ? `worktree-of=${d.result.worktree_base}` : d.result.workdir ? `workdir=${d.result.workdir}` : "") +
          ` ${d.result.stopped_because ?? ""} (on-disk)`.trimEnd());
      if (lines.length === 0 && diskLines.length === 0) {
        return { content: [{ type: "text", text: "No omp agents have run in this session." }] };
      }
      return { content: [{ type: "text", text: [...lines, ...diskLines].join("\n") }] };
    },
  );

  server.tool(
    "omp_usage",
    "Session totals for dispatched work: runs by outcome, turns, tool calls, cost and " +
      "wall time, plus one line per run. The evidence for whether delegation is paying " +
      "off — collect it before reporting a delegated result.",
    {},
    async () => {
      const runs = registry.list();
      if (runs.length === 0) {
        return { content: [{ type: "text", text: "No omp agents have run in this session." }] };
      }
      const by: Record<string, number> = {};
      let turns = 0, toolCalls = 0, cost = 0, seconds = 0;
      for (const { handle } of runs) {
        const r = handle.result;
        by[r.state] = (by[r.state] ?? 0) + 1;
        turns += r.turns;
        toolCalls += r.tool_calls;
        cost += r.cost_usd;
        seconds += r.seconds;
      }
      const outcomes = ["completed", "capped", "aborted", "error", "running", "asking"]
        .map(s => `${s}=${by[s] ?? 0}`).join(" ");
      const perRun = runs
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, handle }) =>
          `${name}  ${handle.result.state.padEnd(9)} turns=${handle.result.turns} ` +
          `cost_usd=${handle.result.cost_usd.toFixed(4)} ${handle.result.stopped_because ?? ""}`.trimEnd())
        .join("\n");
      const text =
        `session dispatched usage: runs=${runs.length} (${outcomes})\n` +
        `turns=${turns} tool_calls=${toolCalls} cost_usd=${cost.toFixed(4)} wall_seconds=${seconds}\n` +
        perRun;
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "omp_task_output",
    "Show state, pending questions and progress, or the final report for a settled run. " +
      "Optionally waits for completion — it returns early the moment the run settles, so " +
      "set wait_seconds as high as your client's MCP call timeout allows. A settled report " +
      "is served in full once per session; later fetches get a compact tombstone (plus, " +
      "with include_diff, the run's git diff — the review surface that never gets " +
      "tombstoned).",
    {
      name: z.string().describe("The run's name."),
      lines: z.number().optional().describe("How many trailing lines to show. Default 40."),
      wait_seconds: z.number().min(0).max(110).optional().describe(
        "Wait for completion up to this many seconds — returns early the moment the run " +
          "settles. Default 0. Keep it under your client's MCP call timeout (Codex's " +
          "documented default is 60s; the 110 maximum serves hosts configured higher).",
      ),
      include_diff: z.boolean().optional().describe(
        "Append the run's git diff (diff.patch, git-derived) to a settled report. Default false.",
      ),
    },
    async ({ name, lines, wait_seconds, include_diff }) => {
      // Review-shaped collection: the settled report plus, on request, the
      // very diff a reviewer would otherwise need git (and an approval) to
      // see. Error replies pass through untouched — the failure is the
      // message, and a run that never ran has no diff worth appending.
      const withDiff = (reply: Reply): Reply => {
        if (!include_diff || reply.isError) return reply;
        const runHandle = registry.get(name);
        if (!runHandle) return reply;
        const diff = readDiff(runHandle.runDir);
        const body = reply.content[0]?.text ?? "";
        return {
          ...reply,
          content: [{
            type: "text",
            text: body + (diff
              ? `\n\n--- diff (git-derived, vs run start) ---\n${diff}`
              : "\n\n(no file changes — no diff was written)"),
          }],
        };
      };
      const operation = operations.get(name);
      if (operation?.reply) return withDiff(serveReply(name, operation));
      // A run from before a restart (or CLI-started): settled artifacts are
      // on disk even though no live handle exists.
      if (!registry.has(name)) {
        const disk = diskRun(name);
        if (disk) return diskReply(disk, include_diff === true);
      }
      const handle = mustFind(name, "omp_task_output");
      if (operation && wait_seconds && handle.result.state !== "asking") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([operation.done, new Promise<void>(resolve => {
            timer = setTimeout(resolve, wait_seconds * 1000);
          })]);
        } finally { clearTimeout(timer); }
        if (operation.reply) return withDiff(serveReply(name, operation));
      }
      const status = liveStatus(name);
      const log = join(handle.runDir, "progress.log");
      let text: string;
      try {
        text = readFileSync(log, "utf8");
      } catch {
        return { content: [{ type: "text", text: `${status}\nNo progress log yet.` }] };
      }
      const all = text.split("\n").filter(Boolean);
      return { content: [{ type: "text", text: status + "\n" + all.slice(-(lines ?? 40)).join("\n") }] };
    },
  );

  server.tool(
    "omp_wait",
    "Wait for one or more dispatched runs to settle — the polling primitive for " +
      "fan-outs. Returns early the moment the condition is met: the first named run to " +
      "settle (default), or all of them with all: true. Settled runs return their reports " +
      "in full (once per session — re-waits get a tombstone); runs still going are " +
      "summarized one line each with tool_calls, cost, liveness age and any parked " +
      "question, so a timeout answers 'what is everyone doing' rather than just 'not " +
      "yet'. Live runs only: on-disk runs are already settled — read those with " +
      "omp_task_output.",
    {
      names: z.array(z.string()).min(1).describe("Run names to wait on, as returned by omp_agent."),
      all: z.boolean().optional().describe(
        "Wait until every named run has settled. Default: the first to settle.",
      ),
      wait_seconds: z.number().min(0).max(110).optional().describe(
        "Give up waiting after this many seconds and return per-run status. Default 30. " +
          "Keep it under your client's MCP call timeout.",
      ),
    },
    async ({ names: rawNames, all, wait_seconds }) => {
      const names = [...new Set(rawNames)];
      const handles = names.map(n => mustFind(n, "omp_wait"));
      // One waiter per run: the tracked operation's reply promise when there
      // is one, else the handle's settle promise — covering the registration
      // window between registry.add and track().
      const settledSignal = (name: string, i: number): Promise<unknown> =>
        operations.get(name)?.done ?? handles[i].settled;
      const condition = all
        ? Promise.all(names.map(settledSignal))
        : Promise.race(names.map(settledSignal));
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          condition,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, (wait_seconds ?? 30) * 1000);
          }),
        ]);
      } finally { clearTimeout(timer); }
      const isSettled = (name: string, i: number) => {
        const r = handles[i].result;
        return operations.get(name)?.reply !== undefined ||
          (r.state !== "running" && r.state !== "asking");
      };
      const settledIdx = names.map((n, i) => isSettled(n, i));
      const settled = names.filter((_, i) => settledIdx[i]);
      const running = names.filter((_, i) => !settledIdx[i]);
      if (settled.length === 0) {
        return { content: [{ type: "text", text:
          `wait timed out after ${wait_seconds ?? 30}s — no named run settled yet:\n` +
          names.map(n => liveStatus(n)).join("\n") +
          `\nAnswer parked questions with omp_answer; wait again, or collect individually with omp_task_output.`,
        }] };
      }
      const replies = settled.map(n => collectSettled(n));
      const tail = running.length
        ? `\n\n--- still running ---\n` + running.map(n => liveStatus(n)).join("\n")
        : "";
      const isError = replies.some(r => r.isError);
      return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: "text", text: replies.map(r => r.content[0].text).join("\n\n") + tail }],
      };
    },
  );

  server.tool(
    "omp_task_stop",
    "Stop a run. It settles as aborted and its report reflects whatever it had done. The " +
      "omp process stays until the server shuts down, so a stopped run can still be " +
      "inspected with omp_task_output.",
    { name: z.string().describe("The run's name.") },
    async ({ name }) => {
      await mustFind(name, "omp_task_stop").stop();
      return { content: [{ type: "text", text: `stopped '${name}'` }] };
    },
  );

  server.tool(
    "omp_answer",
    "Answer a question a run has parked. A dispatched agent that is stuck calls " +
      "ask_supervisor and waits — omp_list_agents shows it as 'asking', and " +
      "omp_task_output shows the question. An unanswered question still burns the " +
      "run's clock, so answer or stop it.",
    {
      name: z.string().describe("The run's name."),
      text: z.string().describe("Your answer. It becomes the tool's return value."),
    },
    async ({ name, text }) => {
      const handle = mustFind(name, "omp_answer");
      const ask = handle.result.ask;
      if (!ask) {
        throw new Error(
          `omp_answer: run '${name}' is not waiting on a question ` +
            `(state ${handle.result.state}).`,
        );
      }
      if (!handle.answer(ask.ask_id, text)) {
        throw new Error(
          `omp_answer: run '${name}' had question ${ask.ask_id} recorded, but nothing was ` +
            `waiting on it — it may have been aborted or already answered.`,
        );
      }
      return { content: [{ type: "text", text: `answered '${name}' (${ask.ask_id})` }] };
    },
  );

  server.tool(
    "omp_ping",
    "Report the omp version this server will dispatch to. Use to confirm the plugin is wired up.",
    {},
    async () => {
      try {
        return { content: [{ type: "text", text: await runOmp(["--version"]) }] };
      } catch (e) {
        throw new Error(`omp_ping failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  server.tool(
    "omp_doctor",
    "Check everything a dispatch depends on: omp on PATH (exit status), omp's own " +
      "SQLite databases (models/agent/stats, write-probed), provider keys, tier " +
      "config, agent definitions and the runs directory. Run this first when omp_* tools are " +
      "missing or misbehaving — it names what to fix. The same checks run without this " +
      "server via `bun <plugin>/bin/server.ts --doctor`.",
    {
      workdir: z.string().optional().describe(
        "Absolute project path to check definitions and config for. Defaults to this " +
        "server process's own working directory.",
      ),
    },
    async ({ workdir }) => {
      const report = await runDiagnostics(workdir ?? process.cwd());
      return report.ok
        ? { content: [{ type: "text", text: report.text }] }
        : { content: [{ type: "text", text: report.text }], isError: true };
    },
  );

  server.tool(
    "omp_models",
    "List omp's model catalogue. Applies provider API keys sourced from the " +
      "user's shell rc files first, since this server is launched by the host " +
      "rather than a login shell and would otherwise miss any provider " +
      "whose key lives only in ~/.zshrc, ~/.bashrc or ~/.profile.",
    {},
    async () => {
      try {
        return { content: [{ type: "text", text: await runOmp(["models"], loadProviderKeys()) }] };
      } catch (e) {
        throw new Error(`omp_models failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  return server;
}

/**
 * Connects a server to real stdio and makes sure every dispatched run's
 * process tree is disposed before this process actually exits. Split out
 * from the `if (import.meta.main)` block below so a test can drive this
 * exact wiring — a real child process, a real StdioServerTransport, a real
 * SIGTERM/stdin shutdown — instead of only ever exercising InMemoryTransport,
 * which (per the onclose comment in createServer()) hides the very gap this
 * exists to close.
 */
export async function runStdioServer(opts: CreateServerOptions = {}): Promise<void> {
  // Run state lives outside the user's repositories and nothing else removes
  // it, so it would otherwise grow without limit — a single run costs about
  // 400KB, almost all of it the raw RPC frame log. Pruned once at startup,
  // best-effort: a directory that cannot be removed must not stop the server.
  try {
    const { removed, freedBytes } = pruneRuns();
    if (removed > 0) {
      process.stderr.write(
        `omp-dispatch: pruned ${removed} old run${removed === 1 ? "" : "s"} ` +
        `(${(freedBytes / 1_048_576).toFixed(1)} MB)\n`,
      );
    }
  } catch { /* never fail startup over housekeeping */ }

  const registry = createRegistry();
  const server = createServer({ ...opts, registry });

  // See the onclose comment in createServer(): the SDK's stdio transport
  // calls onclose on exactly nothing in a real shutdown, so this is the only
  // place SIGTERM, SIGINT, and the parent closing its end of stdin are
  // actually handled. Awaited before exiting — a bare `void` here would race
  // process.exit() against disposeAll()'s own async work (killing every
  // run's process group, restoring locked paths). Safe to fire from more
  // than one of these listeners: disposeAll() snapshots and clears its map
  // synchronously before awaiting anything, so a second concurrent call just
  // finds an empty map and returns immediately.
  const shutdown = () => registry.disposeAll().finally(() => process.exit(0));
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await runStdioServer();
}
