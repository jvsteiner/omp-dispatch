import { test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDef } from "../src/agentdef.ts";

const root = join(import.meta.dir, "..");

test("the plugin manifest declares the MCP server and the skills directory", () => {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(m.name).toBe("omp-dispatch");
  expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(m.mcpServers["omp-dispatch"].args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
  expect(m.skills).toBeDefined();
});

test("the marketplace manifest points at this plugin", () => {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  expect(m.plugins.some((p: any) => p.name === "omp-dispatch")).toBe(true);
});

test("the skill has front matter with a name and a description", () => {
  const s = readFileSync(join(root, "skills/omp-subagents/SKILL.md"), "utf8");
  expect(s.startsWith("---")).toBe(true);
  expect(s).toMatch(/^name:\s*omp-subagents$/m);
  expect(s).toMatch(/^description:\s*\S/m);
});

test("the skill states when to use a native subagent instead", () => {
  const s = readFileSync(join(root, "skills/omp-subagents/SKILL.md"), "utf8");
  expect(s).toMatch(/native subagent when/i);
});

test("the skill documents every tool the server actually registers", () => {
  const s = readFileSync(join(root, "skills/omp-subagents/SKILL.md"), "utf8");
  const server = readFileSync(join(root, "src/mcp/server.ts"), "utf8");
  const registered = [...server.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map(m => m[1]!);
  expect(registered.length).toBeGreaterThan(5);
  for (const tool of registered) {
    if (tool === "omp_ping") continue;   // a wiring check, not part of the workflow
    expect(s).toContain(tool);
  }
});

test("every shipped agent definition parses with no dropped tools", () => {
  const dir = join(root, "agents");
  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const def = parseAgentDef(readFileSync(join(dir, f), "utf8"), join(dir, f));
    expect(def.name).toBe(f.replace(/\.md$/, ""));
    expect(def.description.length).toBeGreaterThan(20);
    // A shipped definition asking for a tool omp cannot provide would be
    // refused by omp_agent — shipping one would be shipping a broken default.
    expect(def.droppedTools).toEqual([]);
    expect(def.ompTools.length).toBeGreaterThan(0);
    expect(def.systemPrompt.length).toBeGreaterThan(50);
  }
});

test("the README exists and explains how to turn this on", () => {
  const p = join(root, "README.md");
  expect(existsSync(p)).toBe(true);
  const r = readFileSync(p, "utf8");
  expect(r).toContain("omp_agent");
  expect(r.toLowerCase()).toContain("claude.md");
});

test("the manifest launches the dependency-installing launcher, not src directly", () => {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const args: string[] = m.mcpServers["omp-dispatch"].args;
  // A marketplace install clones the repo without node_modules, and bundling
  // breaks omp's native addon loader — so src/mcp/server.ts cannot be the
  // entry point or a fresh install serves nothing.
  expect(args[0]).toContain("bin/server.ts");
  expect(args[0]).not.toContain("src/mcp/server.ts");
});

test("the README documents adding the marketplace before installing", () => {
  const r = readFileSync(join(root, "README.md"), "utf8");
  expect(r).toContain("plugin marketplace add");
  const addAt = r.indexOf("plugin marketplace add");
  const installAt = r.indexOf("plugin install");
  expect(addAt).toBeLessThan(installAt);   // order matters; install alone fails
});
