import { z } from "zod";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadProviderKeys } from "../env.ts";
import { startRun } from "../runner.ts";
import {
  AGENT_DEFAULTS, capsFor, pluginVersion, resolveAgentDef, resolveDispatchModel, resultFooter,
} from "../dispatch.ts";
import { runDiagnostics } from "../doctor.ts";
import { readDiff } from "../rundir.ts";
import type { AgentDef } from "../agentdef.ts";
import { newRunId, createRunDir, pruneRuns } from "../rundir.ts";
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


const MODEL_DESCRIPTION =
  "A tier name from your config (haiku, sonnet, opus, or one of your own), or any omp " +
  "model id such as `deepseek/deepseek-v4-pro`. Run `omp_models` to see what is available.";

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
  const operations = new Map<string, { done: Promise<Reply>; reply?: Reply }>();
  // Catch failures even when no client is currently waiting. Keep the reply
  // (including worktree cleanup/errors) available to later polling calls.
  const track = (name: string, promise: Promise<Reply>) => {
    const operation: { done: Promise<Reply>; reply?: Reply } = {
      done: promise.catch(e => ({
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      })),
    };
    operation.done = operation.done.then(reply => { operation.reply = reply; return reply; });
    operations.set(name, operation);
    return operation.done;
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
    "Spawn an omp subagent (DeepSeek or GLM by default) to run a task end to end, in " +
      "place of a native subagent. Set run_in_background for asynchronous dispatch. Otherwise blocks until " +
      "the run settles and returns its final report followed by a compact footer. A cap " +
      "breach (max turns or max spend) is reported in that footer, not thrown.",
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
      model: z.string().optional().describe(MODEL_DESCRIPTION),
      name: z.string().optional().describe(
        "A name for this run, for use later with omp_send_message. Auto-generated from " +
          "description when omitted. An explicit name already in use is an error naming " +
          "the run that already has it — it is never silently suffixed.",
      ),
      isolation: z.enum(["none", "worktree"]).optional().describe(
        "'none' (default) runs in workdir, like a native subagent. 'worktree' gives the " +
          "run its own git checkout so it can write freely without touching your working " +
          "tree — the same guarantee Agent's isolation: \"worktree\" offers. An unchanged " +
          "worktree is cleaned up; one the agent left work in is kept and its path reported.",
      ),
      workdir: z.string().optional().describe(
        "Absolute path the agent runs in. Defaults to this MCP server process's own " +
          "working directory.",
      ),
      run_in_background: z.boolean().optional().describe(
        "Return the run name, resolved model and caps after startup; collect the report " +
        "with omp_task_output. Recommended for Codex.",
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

        // Registered the moment the run exists, not once it settles: steering
        // it, tailing it or stopping it are only useful WHILE it is running,
        // and omp_agent blocks for the whole of that. The omp process
        // deliberately outlives the run so a later omp_send_message can
        // resume it, so dispose() is the registry's job from here on — except
        // on the error path below, which removes and disposes it.
        registry.add(runName, handle);

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
            throw new Error(
              `omp_agent: run '${runName}' (${runId}) did not complete: ` +
              `${result.stopped_because ?? "error"}. See ${runDir}/progress.log for details.${isolationNote}`,
            );
          }

          // The footer prefers RunResult.model — the agent's own reported
          // state, and the one field that can drift from what was asked for —
          // falling back to the resolved request string only when the run
          // ended before it could report one.
          const footer = resultFooter(runName, result, { modelLabel: resolvedModel, runDir });

          return {
            content: [{ type: "text", text: (result.last_reply ?? "(no reply)") + footer + isolationNote }],
          };
        };
        const done = track(runName, finish());
        if (run_in_background) {
          return { content: [{ type: "text", text:
            `Started '${runName}' model=${resolvedModel} ` +
            `max_turns=${caps.maxTurns} max_usd=${caps.maxUsd.toFixed(2)} ` +
            `max_seconds=${caps.maxSeconds}.\n` +
            `Collect with omp_task_output({name: ${JSON.stringify(runName)}, wait_seconds: 25}). ` +
            `Run directory: ${runDir}\n` +
            `Wrong model? omp_task_stop({name: ${JSON.stringify(runName)}}) and dispatch again ` +
            `with model=<id> — omp_models lists what is available.`,
          }] };
        }
        return await done;
      } finally {
        clearInterval(progressTimer);
        reserved.delete(runName);
      }
    },
  );

  // --- conversation: the native-parity half of the surface -----------------
  //
  // Each of these names a run the way Agent's own companions do. A run that
  // cannot be found is always an error naming it AND listing what does exist:
  // the caller has just mistyped a name it will have to get right to continue,
  // and a bare "not found" makes it guess.

  const mustFind = (name: string, tool: string) => {
    const handle = registry.get(name);
    if (!handle) {
      const known = registry.list().map(r => r.name).sort();
      throw new Error(
        `${tool}: no run named '${name}'. ` +
          (known.length ? `Running or finished: ${known.join(", ")}.` : `No runs yet.`),
      );
    }
    return handle;
  };

  server.tool(
    "omp_send_message",
    "Continue a run with a follow-up, keeping its context — the omp equivalent of " +
      "SendMessage. Works on a run that has already finished: it is resumed rather than " +
      "restarted. A run that stopped for any other reason (a cap, an abort, an error) " +
      "refuses, naming the reason. Blocks until the new turn settles and returns its reply.",
    {
      to: z.string().describe("The run's name, as returned by omp_agent or omp_list_agents."),
      message: z.string().describe("The follow-up to send."),
      run_in_background: z.boolean().optional().describe("Return immediately; collect with omp_task_output. Recommended for Codex."),
    },
    async ({ to, message, run_in_background }) => {
      const handle = mustFind(to, "omp_send_message");
      if (operations.has(to) && !operations.get(to)!.reply) {
        throw new Error(`omp_send_message: run '${to}' is still active; use omp_steer or wait for its result.`);
      }
      const finish = async (): Promise<Reply> => {
        const reply = await handle.say(message);
        const footer = resultFooter(to, handle.result, { runDir: handle.runDir });
        return { content: [{ type: "text", text: (reply || "(no reply)") + footer }] };
      };
      const done = track(to, finish());
      if (run_in_background) {
        return { content: [{ type: "text", text: `Continuing '${to}'. Collect with omp_task_output.` }] };
      }
      return await done;
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
      "turns and cost so far.",
    {},
    async () => {
      const runs = registry.list();
      if (runs.length === 0) {
        return { content: [{ type: "text", text: "No omp agents have run in this session." }] };
      }
      const lines = runs.map(({ name, handle }) => {
        const r = handle.result;
        return `${name}  ${r.state.padEnd(10)} turns=${r.turns} ` +
          `cost_usd=${r.cost_usd.toFixed(4)} ${r.stopped_because ?? ""}`.trimEnd();
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
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
      "Optionally wait up to 30 seconds, below Codex's default MCP timeout. Set " +
      "include_diff to append the run's git diff to a settled report, so a review needs " +
      "no separate git call.",
    {
      name: z.string().describe("The run's name."),
      lines: z.number().optional().describe("How many trailing lines to show. Default 40."),
      wait_seconds: z.number().min(0).max(30).optional().describe("Wait for completion up to this many seconds. Default 0."),
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
      if (operation?.reply) return withDiff(operation.reply);
      const handle = mustFind(name, "omp_task_output");
      if (operation && wait_seconds && handle.result.state !== "asking") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([operation.done, new Promise<void>(resolve => {
            timer = setTimeout(resolve, wait_seconds * 1000);
          })]);
        } finally { clearTimeout(timer); }
        if (operation.reply) return withDiff(operation.reply);
      }
      const status = `run '${name}': state=${handle.result.state}` +
        (handle.result.ask ? ` question=${JSON.stringify(handle.result.ask)}` : "");
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
