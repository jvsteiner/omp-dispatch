import { test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentDef } from "../src/agentdef.ts";

const root = join(import.meta.dir, "..");
const plugin = join(root, "plugin");

test("Codex and Claude packages share the version, skill and dependency-installing launcher", () => {
  const codex = JSON.parse(readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  expect(codex.name).toBe(claude.name);
  expect(codex.version).toBe(claude.version);
  expect(codex.skills).toBe(claude.skills);
  // Same launcher, two addressings: Codex gets a plugin-root-relative path
  // (it expands nothing), Claude gets ${CLAUDE_PLUGIN_ROOT} (its plugin
  // loader expands it). The detailed contract lives in the test below.
  const mcp = JSON.parse(readFileSync(join(plugin, codex.mcpServers), "utf8"));
  expect(mcp.mcpServers["omp-dispatch"].command).toBe(claude.mcpServers["omp-dispatch"].command);
  const relative = mcp.mcpServers["omp-dispatch"].args[0];
  expect(existsSync(join(plugin, relative))).toBe(true);
});

test("the two hosts' launch contracts both hold: cwd-anchored .mcp.json for Codex, inline variable for Claude", () => {
  // Codex (verified against its binary and by reproduction) expands no
  // ${...} variables, pins the mcpServers contract to exactly ".mcp.json",
  // and resolves the server's cwd field against the PLUGIN ROOT at load
  // time — while args resolve against the *process* cwd. So the anchor is
  // the cwd field, and the args must be relative to IT: "cwd": "./" +
  // "dist/server.js". A bare relative arg (0.2.5) only worked in a checkout
  // of this very repo, because the repo happened to contain the path.
  const codex = JSON.parse(readFileSync(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
  expect(codex.mcpServers).toBe("./.mcp.json");
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
  const entry = mcp.mcpServers["omp-dispatch"];
  expect(entry.cwd).toBe("./");
  expect(entry.args.join(" ")).not.toContain("${");
  expect(existsSync(join(plugin, entry.cwd, entry.args[0]))).toBe(true);
  // Claude Code expands ${CLAUDE_PLUGIN_ROOT} in its own inline plugin
  // manifest — the one place the variable is actually supported — and its
  // plugin cache is never a project root, so the variable is correct there.
  const claude = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  expect(claude.mcpServers["omp-dispatch"].args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");

  // A root .mcp.json would be auto-loadable project config for anyone
  // working in a checkout: a second server beside the installed plugin's.
  // Codex's .mcp.json lives in plugin/, so the checkout root carries none.
  expect(existsSync(join(root, ".mcp.json"))).toBe(false);
});

test("the plugin manifest declares the MCP server and the skills directory", () => {
  const m = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
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
  const s = readFileSync(join(plugin, "skills/omp-subagents/SKILL.md"), "utf8");
  expect(s.startsWith("---")).toBe(true);
  expect(s).toMatch(/^name:\s*omp-subagents$/m);
  expect(s).toMatch(/^description:\s*\S/m);
});

test("the skill states when to use a native subagent instead", () => {
  const s = readFileSync(join(plugin, "skills/omp-subagents/SKILL.md"), "utf8");
  expect(s).toMatch(/native subagent when/i);
});

test("the skill documents every tool the server actually registers", () => {
  const s = readFileSync(join(plugin, "skills/omp-subagents/SKILL.md"), "utf8");
  const server = readFileSync(join(root, "src/mcp/server.ts"), "utf8");
  const registered = [...server.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map(m => m[1]!);
  expect(registered.length).toBeGreaterThan(5);
  for (const tool of registered) {
    if (tool === "omp_ping") continue;   // a wiring check, not part of the workflow
    expect(s).toContain(tool);
  }
});

test("every shipped agent definition parses with no dropped tools", () => {
  const dir = join(plugin, "agents");
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

test("both manifests launch the committed bundle", () => {
  // A marketplace install is a git clone with no install step, so what the
  // manifests launch must be complete on its own: one bundled file.
  const claude = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  expect(claude.mcpServers["omp-dispatch"].args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/dist/server.js");
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
  expect(mcp.mcpServers["omp-dispatch"].args[0]).toBe("dist/server.js");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.dependencies ?? {}).toEqual({});
});

test("dist/ holds the build of the current source", async () => {
  // Users run the committed bundles, not src/. Rebuild with `bun run build`.
  // Bundle output varies across bun versions, so the build is pinned: on any
  // other bun a mismatch would say "stale dist" about unchanged source.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "")?.[1];
  expect(pinned).toBeDefined();
  if (Bun.version !== pinned) {
    throw new Error(`dist/ is built with bun ${pinned} (package.json packageManager); this is bun ${Bun.version}. ` +
      `Run the tests and \`bun run build\` with bun ${pinned}.`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "omp-build-"));
  for (const [entry, out] of [["bin/server.ts", "server.js"], ["bin/dispatch.ts", "dispatch.js"]]) {
    await Bun.$`bun build ${entry} --target=bun --outfile ${join(tmp, out)}`.cwd(root).quiet();
    expect(readFileSync(join(plugin, "dist", out), "utf8")).toBe(readFileSync(join(tmp, out), "utf8"));
  }
});

test("the bundle does not contain omp's native addon loader", () => {
  // RpcClient drags it in, and it cannot load without omp's node_modules;
  // RpcClient comes from the omp on PATH instead (src/ompinstall.ts).
  for (const f of ["server.js", "dispatch.js"]) {
    expect(readFileSync(join(plugin, "dist", f), "utf8")).not.toContain("pi_natives native addon");
  }
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
  const plug = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.version).toBe(plug.version);
});

test("plugin and marketplace manifests agree on the version", () => {
  const p = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
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
    readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"),
  ).version;
  expect(client.getServerVersion()?.version).toBe(declared);
  await client.close();
});

test("the bundle's --doctor mode reports and exits without starting a server", async () => {
  // The shipped entry point, run the way a host or a supervising agent runs
  // it: the doctor must work from the bundle alone.
  const p = Bun.spawn(["bun", join(plugin, "dist/server.js"), "--doctor", "--workdir", root], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), 20_000);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  expect(out).toMatch(/doctor: \d+\/\d+ checks passed/);
}, 30_000);

test("the bundle serves MCP once: one reply per request", async () => {
  // src/mcp/server.ts starts itself under `if (import.meta.main)`. Bun
  // rewrites that to `if (false)` for every module but the bundle entry; if
  // it ever stopped, a second server would share stdin and answer twice.
  const p = Bun.spawn(["bun", join(plugin, "dist/server.js")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  p.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }) + "\n");
  await p.stdin.flush();
  await Bun.sleep(1500);
  p.stdin.end();
  const timer = setTimeout(() => p.kill(), 10_000);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  const replies = out.split("\n").filter(l => l.includes('"id":1'));
  expect(replies.length).toBe(1);
}, 30_000);

test("the marketplace installs plugin/, which carries no package.json or lockfile", () => {
  // Claude Code runs `bun install` (dev dependencies included, no opt-out)
  // in any installed plugin root holding a package.json and a lockfile —
  // 861MB the bundle never uses. The repo root keeps both for development;
  // the plugin the marketplace points at must hold neither.
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  const source = m.plugins.find((x: { name: string }) => x.name === "omp-dispatch").source;
  expect(source).toBe("./plugin");
  const dir = join(root, source);
  for (const f of ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "node_modules"]) {
    expect(existsSync(join(dir, f))).toBe(false);
  }
  for (const f of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".mcp.json", "dist/server.js", "dist/dispatch.js", "skills/omp-subagents/SKILL.md", "LICENSE"]) {
    expect(existsSync(join(dir, f))).toBe(true);
  }
});

test("the bundle reports the plugin's version from inside plugin/", async () => {
  // plugin/ has no package.json, so the bundle must read its own manifest.
  const version = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8")).version;
  const out = await Bun.$`bun ${join(plugin, "dist/server.js")} --doctor --workdir ${root}`.nothrow().quiet().text();
  expect(out).toContain(`omp-dispatch ${version} doctor`);
}, 30_000);
