import { test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDef } from "../src/agentdef.ts";

const root = join(import.meta.dir, "..");

test("Codex and Claude packages share the version, skill and dependency-installing launcher", () => {
  const codex = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(codex.name).toBe(claude.name);
  expect(codex.version).toBe(claude.version);
  expect(codex.skills).toBe(claude.skills);
  const mcp = JSON.parse(readFileSync(join(root, codex.mcpServers), "utf8"));
  expect(mcp.mcpServers["omp-dispatch"]).toEqual(claude.mcpServers["omp-dispatch"]);
  const launcher = mcp.mcpServers["omp-dispatch"].args[0].replace("${CLAUDE_PLUGIN_ROOT}", root);
  expect(existsSync(launcher)).toBe(true);
});

test("no .mcp.json at the repo root — Claude Code auto-loads that exact name as project config", () => {
  // A root .mcp.json is project MCP config in Claude Code, not a plugin
  // artifact: ${CLAUDE_PLUGIN_ROOT} cannot expand there, so the server
  // registers and immediately fails in every Claude session opened in a
  // checkout of this repo (observed as a red "✗ failed" MCP entry). Codex's
  // launch config lives in the file .codex-plugin/plugin.json points at,
  // which must not carry this name.
  expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  const codex = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
  expect(codex.mcpServers).not.toBe("./.mcp.json");
  expect(existsSync(join(root, codex.mcpServers))).toBe(true);
});

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

test("package.json carries a version and matches the manifest", () => {
  // It had none at all, so a version bump silently skipped it and the server
  // fell back to 0.0.0. A missing field is easy to not notice.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plug = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.version).toBe(plug.version);
});

test("plugin and marketplace manifests agree on the version", () => {
  const p = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  const entry = m.plugins.find((x: any) => x.name === "omp-dispatch");
  // A marketplace install resolves the version from the marketplace entry, so
  // a drift here means users install something other than what was released.
  expect(entry.version).toBe(p.version);
});

test("the licence is MIT and the file is present", () => {
  const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(p.license).toBe("MIT");
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("MIT License");
});

test("the MCP server reports the version the package actually is", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer } = await import("../src/mcp/server.ts");

  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await Promise.all([createServer().connect(a), client.connect(b)]);

  const declared = JSON.parse(
    readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"),
  ).version;
  expect(client.getServerVersion()?.version).toBe(declared);
  await client.close();
});
