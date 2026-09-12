import { z } from "zod";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadProviderKeys } from "../env.ts";
import { loadTierConfig, resolveModel } from "../models.ts";
import { startRun } from "../runner.ts";
import { newRunId, createRunDir } from "../rundir.ts";
import { TASK_DEFAULTS } from "../taskfile.ts";
import { createRegistry, uniqueName } from "./runs.ts";

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
 * Test-only escape hatch: when set, every omp_agent dispatch is launched
 * through this argv (a JSON-encoded array) instead of the real omp CLI.
 * Read per call, not at module load — the same reason src/runner.ts reads
 * OMP_DISPATCH_POLL_MS per call: a module-level constant would be frozen
 * before a test ever gets a chance to set it. Deliberately not part of
 * omp_agent's own schema: its signature mirrors the native Agent tool
 * exactly, and this has no native equivalent.
 */
function testCommandOverride(): string[] | undefined {
  const raw = process.env.OMP_DISPATCH_TEST_COMMAND;
  return raw ? (JSON.parse(raw) as string[]) : undefined;
}

const MODEL_DESCRIPTION =
  "A tier name from your config (haiku, sonnet, opus, or one of your own), or any omp " +
  "model id such as `deepseek/deepseek-v4-pro`. Run `omp_models` to see what is available.";

export function createServer(): McpServer {
  const server = new McpServer({ name: "omp-dispatch", version: "0.1.0" });

  // Every dispatched run lives here, keyed by name, once it has settled — see
  // src/mcp/runs.ts. `reserved` closes the race a bare registry can't: two
  // concurrent dispatches with the same auto-generated name would otherwise
  // both see the name free, since nothing is added to the registry itself
  // until well after the run has settled. A name is reserved synchronously,
  // with no `await` in between, the instant it is chosen.
  const registry = createRegistry();
  const reserved = new Set<string>();
  const isTaken = (n: string) => registry.has(n) || reserved.has(n);

  server.tool(
    "omp_agent",
    "Spawn an omp subagent (DeepSeek or GLM by default) to run a task end to end, in " +
      "place of a native Claude subagent, at a fraction of the token cost. Blocks until " +
      "the run settles and returns its final report followed by a compact footer. A cap " +
      "breach (max turns or max spend) is reported in that footer, not thrown.",
    {
      description: z.string().describe("A short (3-5 word) description of the task"),
      prompt: z.string().describe("The task for the agent to perform"),
      subagent_type: z.string().optional().describe(
        "Native subagent type name, kept for parity with Agent. Agent-definition lookup " +
          "(.claude/agents/*.md) is not wired up yet — every dispatch currently runs with " +
          "the default tool set regardless of this value.",
      ),
      model: z.string().optional().describe(MODEL_DESCRIPTION),
      name: z.string().optional().describe(
        "A name for this run, for use later with omp_send_message. Auto-generated from " +
          "description when omitted. An explicit name already in use is an error naming " +
          "the run that already has it — it is never silently suffixed.",
      ),
      isolation: z.string().optional().describe(
        "Worktree isolation mode, kept for parity with Agent. Not implemented yet — every " +
          "dispatch runs directly in workdir.",
      ),
      workdir: z.string().optional().describe(
        "Absolute path the agent runs in. Defaults to this MCP server process's own " +
          "working directory.",
      ),
    },
    async ({ description, prompt, model, name, workdir }) => {
      const targetWorkdir = workdir ?? process.cwd();

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

      try {
        const home = process.env.HOME ?? "";
        const cfg = loadTierConfig([
          join(home, ".omp-dispatch", "config.json"),
          join(targetWorkdir, ".omp-dispatch", "config.json"),
        ]);
        const resolvedModel = resolveModel(model, cfg);

        const runId = newRunId();
        const runDir = createRunDir(targetWorkdir, runId);

        // loadProviderKeys() must land in the child's env or its catalogue
        // is missing every provider whose key lives only in a shell rc file
        // — see src/env.ts.
        const handle = await startRun(
          {
            prompt,
            model: resolvedModel,
            workdir: targetWorkdir,
            tools: TASK_DEFAULTS.tools,
            maxTurns: TASK_DEFAULTS.maxTurns,
            maxUsd: TASK_DEFAULTS.maxUsd,
            maxSeconds: TASK_DEFAULTS.maxSeconds,
            env: loadProviderKeys(),
            command: testCommandOverride(),
          },
          runDir,
          runId,
        );

        const result = await handle.settled;

        // A cap breach (max_turns/max_usd/max_seconds) is a result, not an
        // exception — the run's own report and footer say so via
        // stopped_because. Only a failure to start (or a mid-run failure the
        // runner could not recover from) reaches state "error", and that is
        // the one case this throws instead of returning a footer.
        if (result.state === "error") {
          // Not kept in the registry, so it must be disposed here: Task 3
          // deliberately leaves a settled run's omp process alive until
          // dispose(), and any handle dropped without that call leaks it.
          await handle.dispose();
          throw new Error(
            `omp_agent: run '${runName}' (${runId}) did not complete: ` +
              `${result.stopped_because ?? "error"}. See ${runDir}/progress.log for details.`,
          );
        }

        // Kept deliberately: the omp process stays alive so a later
        // omp_send_message can resume this run. dispose() is someone else's
        // job from here on.
        registry.add(runName, handle);

        const footer =
          `\n\n---\n[omp:${runName}] model=${resolvedModel} turns=${result.turns} ` +
          `tool_calls=${result.tool_calls} cost_usd=${result.cost_usd.toFixed(4)} ` +
          `seconds=${result.seconds} stopped_because=${result.stopped_because}`;

        return {
          content: [{ type: "text", text: (result.last_reply ?? "(no reply)") + footer }],
        };
      } finally {
        reserved.delete(runName);
      }
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
    "omp_models",
    "List omp's model catalogue. Applies provider API keys sourced from the " +
      "user's shell rc files first, since this server is launched by Claude " +
      "Code rather than a login shell and would otherwise miss any provider " +
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

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
