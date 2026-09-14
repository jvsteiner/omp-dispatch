import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentDef } from "./agentdef.ts";
import { discoverAgentDefs } from "./agentdef.ts";
import { loadTierConfig, resolveModel } from "./models.ts";
import type { RunResult } from "./rundir.ts";

export function pluginVersion(): string {
  try {
    // Both host manifests are kept in step with the shared package version.
    // This module lives in src/, one level down from the root package.json.
    const manifest = join(dirname(import.meta.path), "..", "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * omp_agent's own defaults — deliberately not src/taskfile.ts's TASK_DEFAULTS,
 * which exists for the unattended file-driven path where nobody is blocked
 * waiting for the result. omp_agent blocks a live Claude turn, so maxSeconds
 * here favors a bounded wait over unattended endurance: the v1 reference run
 * (docs/specs/2026-09-12-omp-dispatch-design.md) took ~700s end to end, and
 * 1200s gives roughly double that for a slower model or a retry.
 *
 * Shared by the MCP server and the dispatch CLI so the two entry points can
 * never drift into reporting different caps for the same run.
 */
export const AGENT_DEFAULTS = {
  tools: "read,write,edit,bash",
  maxTurns: 120,
  maxUsd: 1.0,
  maxSeconds: 1200,
};


/**
 * The contract every definition-less dispatch runs under: fire-and-forget.
 * The dispatch's whole value is that the caller stops paying attention, so
 * the agent's single reply is the entire deliverable — not the opening of a
 * conversation, and not a place to narrate process. Three observed failure
 * modes shaped it (a 52-word report on a one-line diff, restating the
 * diff's content, listing prohibited actions never taken), plus one design
 * flaw: a relative-length rule cannot hold when the verifying output alone
 * outgrows a one-line change. Hence an absolute bullet cap.
 */
export const DEFAULT_REPORTING_PROMPT = [
  "You are dispatched fire-and-forget. This one reply is the entire deliverable:",
  "nobody will answer it, nobody will ask a follow-up, and the caller reads the diff.",
  "At most three bullets:",
  "1. what changed — file names only; never restate what the diff already shows",
  "2. what verifies it — the commands you ran and their actual output",
  "3. what failed — its raw output, and no cause you did not establish",
  "Omit any bullet you have nothing for. Do not restate the brief, narrate your",
  "process, explain false starts, or list things you did not do.",
].join("\n");

/**
 * One live-status line for a run that has not settled, shared by
 * omp_task_output and the CLI so a poll answers "is it working, how far,
 * how much" instead of just "running".
 */
export function runningStatus(name: string, result: RunResult, runDir: string): string {
  const elapsed = Math.max(0, Math.round((Date.now() - statSync(runDir).birthtimeMs) / 1000));
  return `run '${name}': state=${result.state} turns=${result.turns} ` +
    `cost_usd=${result.cost_usd.toFixed(4)} elapsed=${elapsed}s` +
    (result.ask ? ` question=${JSON.stringify(result.ask)}` : "");
}
/**
 * Resolve `subagent_type` to a definition, or refuse — with the same error
 * text the MCP tool has always produced, so a caller reading a refusal from
 * the CLI is not reading a second, subtly different dialect of it.
 *
 * A definition quietly missing the tool it was written around produces
 * confident wrong work; refusing and naming everything missing is the whole
 * point.
 */
export function resolveAgentDef(subagentType: string, workdir: string, home: string): AgentDef {
  const { defs, errors } = discoverAgentDefs(workdir, home);
  const def = defs.get(subagentType);
  if (!def) {
    const available = [...defs.keys()].sort();
    throw new Error(
      `omp_agent: no agent definition named '${subagentType}' under ` +
        `.omp-dispatch/agents or .claude/agents in ${workdir} or the home directory. ` +
        (available.length
          ? `Available: ${available.join(", ")}.`
          : `No definitions were found.`) +
        (errors.length ? ` Parse errors: ${errors.join("; ")}` : ""),
    );
  }
  if (def.droppedTools.length > 0) {
    throw new Error(
      `omp_agent: agent '${subagentType}' (${def.source}) requires ` +
        `${def.droppedTools.length === 1 ? "a tool" : "tools"} omp has no equivalent ` +
        `for: ${def.droppedTools.join(", ")}. Refusing rather than running a weakened ` +
        `agent — use a native subagent for this one.`,
    );
  }
  return def;
}

/**
 * Precedence, highest first: an explicit argument, the definition's model:,
 * then the configured default tier. `workdir` should be the directory the run
 * will actually execute in, so a project config there applies.
 *
 * When the effective config sets `allow`, the resolved model must be on it.
 * The refusal names where the model came from — argument, definition, or
 * default tier — because the fix differs: change the argument, the
 * definition, or the config.
 */
export function resolveDispatchModel(
  requested: string | undefined,
  def: AgentDef | undefined,
  workdir: string,
  home: string,
): string {
  const cfg = loadTierConfig([
    join(home, ".omp-dispatch", "config.json"),
    join(workdir, ".omp-dispatch", "config.json"),
  ]);
  const raw = requested ?? def?.model;
  const trimmed = raw?.trim();
  const origin = requested !== undefined
    ? `the model argument '${trimmed}'`
    : def?.model !== undefined
      ? `agent definition '${def.name}' (${def.source}) setting model: '${trimmed}'`
      : `the configured default tier '${cfg.default}'`;
  const resolved = resolveModel(raw, cfg);
  if (cfg.allow && !cfg.allow.includes(resolved)) {
    throw new Error(
      `${origin} resolved to '${resolved}', which is not on this config's allow list.\n` +
      `Allowed models: ${cfg.allow.join(", ")}\n` +
      `Allowed tier names (each maps to a model you configured): ` +
      `${Object.keys(cfg.tiers).sort().join(", ")} — pass one of those instead.\n` +
      `Adjust 'allow', 'tiers' or 'default' in ~/.omp-dispatch/config.json or ` +
      `${join(workdir, ".omp-dispatch", "config.json")}.`,
    );
  }
  return resolved;
}

/** Cap for a run: the definition's maxTurns wins over the default. */
export function capsFor(def: AgentDef | undefined, overrides?: {
  maxTurns?: number; maxUsd?: number; maxSeconds?: number;
}) {
  return {
    maxTurns: overrides?.maxTurns ?? def?.maxTurns ?? AGENT_DEFAULTS.maxTurns,
    maxUsd: overrides?.maxUsd ?? AGENT_DEFAULTS.maxUsd,
    maxSeconds: overrides?.maxSeconds ?? AGENT_DEFAULTS.maxSeconds,
  };
}

/**
 * The one-line footer every settled run reports through, whether it was
 * collected over MCP or from the CLI. `files_changed` is git-derived (see
 * runner.ts) and the diff pointer names a patch the supervisor can read
 * without running git itself — one approval-free review surface.
 */
export function resultFooter(
  name: string,
  result: RunResult,
  opts: { modelLabel?: string; runDir?: string; extra?: Record<string, string> } = {},
): string {
  const modelLabel = result.model
    ? `${result.model.provider}/${result.model.id}`
    : (opts.modelLabel ?? "");
  const parts = [
    `[omp:${name}]`,
    ...modelLabel ? [`model=${modelLabel}`] : [],
    `turns=${result.turns}`,
    `tool_calls=${result.tool_calls}`,
    `cost_usd=${result.cost_usd.toFixed(4)}`,
    `seconds=${result.seconds}`,
    `stopped_because=${result.stopped_because}`,
    ...Object.entries(opts.extra ?? {}).map(([k, v]) => `${k}=${v}`),
  ];
  const changed = result.files_changed;
  if (changed && changed.length > 0) {
    const joined = changed.join(", ");
    const trimmed = joined.length > 200
      ? joined.slice(0, 200) + ` … (${changed.length} files)`
      : joined;
    parts.push(`files_changed=${trimmed}`);
    if (opts.runDir) parts.push(`diff=${join(opts.runDir, "diff.patch")}`);
  }
  return `\n\n---\n` + parts.join(" ");
}
