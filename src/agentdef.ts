import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface AgentDef {
  name: string;
  description: string;
  /** The markdown body, which becomes the agent's system prompt. */
  systemPrompt: string;
  /** Translated omp tool names, after disallowedTools has been subtracted. */
  ompTools: string[];
  /** Claude tools with no omp equivalent. Reported, never silently discarded. */
  droppedTools: string[];
  maxTurns?: number;
  model?: string;
  /** Absolute path, so every error can name the file it came from. */
  source: string;
}

/**
 * Claude Code tool names to omp tool names. Verified against omp's own tool list.
 *
 * `WebFetch` maps to `read` because omp's read tool takes URLs, so two Claude
 * tools collapse onto one omp tool — callers must de-duplicate.
 */
export const TOOL_MAP: Readonly<Record<string, string>> = Object.freeze({
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  WebSearch: "web_search",
  WebFetch: "read",
  NotebookEdit: "notebook",
  Agent: "task",
  TodoWrite: "todo",
});

/**
 * Anything without an omp equivalent — Skill, ToolSearch, SendMessage, any mcp__*
 * tool — goes to `dropped`. An agent quietly missing the tool it was written
 * around produces confident wrong work, so the caller refuses rather than
 * running a weakened agent.
 */
export function translateTools(
  tools: string[],
  disallowed: string[],
): { ompTools: string[]; dropped: string[] } {
  const denied = new Set(disallowed.map(t => t.trim()).filter(Boolean));
  const ompTools: string[] = [];
  const dropped: string[] = [];
  for (const raw of tools) {
    const name = raw.trim();
    if (!name || denied.has(name)) continue;
    const mapped = TOOL_MAP[name];
    if (mapped === undefined) {
      if (!dropped.includes(name)) dropped.push(name);
    } else if (!ompTools.includes(mapped)) {
      ompTools.push(mapped);
    }
  }
  return { ompTools, dropped };
}

function splitFrontMatter(text: string, source: string): { head: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${source}: no front matter block (expected a --- block at the top)`);
  return { head: m[1]!, body: m[2]!.trim() };
}

/**
 * Claude's format uses comma-separated inline lists (`tools: Read, Grep`) where
 * this repo's task files use bracket lists. Both are small enough not to warrant
 * a YAML dependency.
 */
function parseHead(head: string, source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) throw new Error(`${source}: bad front-matter line: ${raw}`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * `tools: []` means NO tools. Treating an empty list as "unset" would hand a
 * deliberately locked-down agent the full toolset.
 */
function toolList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "[]") return [];
  const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  return inner.split(",").map(s => s.trim()).filter(Boolean);
}

export function parseAgentDef(text: string, source: string): AgentDef {
  const { head, body } = splitFrontMatter(text, source);
  const f = parseHead(head, source);

  const name = f.name;
  if (!name) throw new Error(`${source}: agent definition must set name`);
  const description = f.description ?? "";

  // An absent `tools` means the definition did not constrain them; an empty
  // list means it constrained them to none.
  const declared = toolList(f.tools) ?? Object.keys(TOOL_MAP);
  const { ompTools, dropped } = translateTools(declared, toolList(f.disallowedTools) ?? []);

  let maxTurns: number | undefined;
  if (f.maxTurns !== undefined) {
    const n = Number(f.maxTurns);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${source}: maxTurns must be a positive integer, got '${f.maxTurns}'`);
    }
    maxTurns = n;
  }

  return {
    name,
    description,
    systemPrompt: body,
    ompTools,
    droppedTools: dropped,
    maxTurns,
    model: f.model || undefined,
    source,
  };
}

export interface Discovered {
  defs: Map<string, AgentDef>;
  /** One message per file that could not be parsed. Never silent. */
  errors: string[];
}

function loadDir(dir: string, into: Map<string, AgentDef>, errors: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const def = parseAgentDef(readFileSync(path, "utf8"), path);
      // First writer wins, so the project directory shadows the user one.
      if (!into.has(def.name)) into.set(def.name, def);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `${path}: ${String(e)}`);
    }
  }
}

/** Project definitions shadow user ones of the same name. */
export function discoverAgentDefs(cwd: string, home: string): Discovered {
  const defs = new Map<string, AgentDef>();
  const errors: string[] = [];
  loadDir(join(cwd, ".omp-dispatch", "agents"), defs, errors);
  loadDir(join(cwd, ".claude", "agents"), defs, errors);
  loadDir(join(home, ".omp-dispatch", "agents"), defs, errors);
  loadDir(join(home, ".claude", "agents"), defs, errors);
  return { defs, errors };
}
