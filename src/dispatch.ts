import { readFileSync } from "node:fs";
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
  return resolveModel(requested ?? def?.model, cfg);
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
