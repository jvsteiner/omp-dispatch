# omp-dispatch v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Claude Code plugin whose MCP server lets Claude spawn omp subagents — running DeepSeek or GLM — in place of native Sonnet/Haiku subagents, reading the same `.claude/agents/*.md` files, so it can be turned on by default without a migration.

**Architecture:** One long-lived MCP server holds `Map<name, RunHandle>`; each handle owns an `RpcClient` talking to `omp --mode rpc`. Because the server outlives individual tool calls, v1's detached broker, unix socket, pidfile and process-group machinery are all unnecessary and are not built. Run state still mirrors to disk for inspection and resume.

**Tech Stack:** bun 1.4.0, TypeScript, `bun:test`, `@modelcontextprotocol/sdk`, `@oh-my-pi/pi-coding-agent`'s `RpcClient`.

**Spec:** `docs/specs/2026-09-12-omp-dispatch-v2-design.md`

## Starting state

Branch `build/omp-dispatch-m1-m4`, HEAD `c28416c`, **66 tests passing**. v1 Tasks 1–5 are built and reviewed. This plan reuses them:

| Existing file | Status in v2 |
|---|---|
| `src/caps.ts` | unchanged, reused as-is |
| `src/rundir.ts` | unchanged, reused as-is |
| `src/preflight.ts` | unchanged; `lockPaths`/`unlockPaths` become optional, provider guard central |
| `src/taskfile.ts` | kept for the file-driven path (spec §12.3) |
| `test/fake-omp.ts` | unchanged, still the offline test double |
| `src/broker.ts` | **source material for `src/runner.ts`** — see Task 3 |

## Global Constraints

- bun ≥ 1.4.0, TypeScript, `bun:test` only. macOS and Linux.
- **No test may call a model provider** except the smoke test in Task 11.
- Counts and cost come from `getSessionStats()`. Never count frames for a number.
- A turn completes only on `agent_end` where `isTerminal !== false`.
- **Caps are `>=` on every axis.** Permissive at a boundary is the one direction they must not fail.
- **The turn cap is primary.** `getSessionStats().cost` can read 0 on subscription providers (zai OAuth), so a run must never depend on `max_usd` alone.
- **Every default is user-overridable.** Model choice especially: config file, agent definition, or explicit argument.
- **Refuse, never silently downgrade.** An agent definition asking for an untranslatable tool is an error naming the tool.
- **Teardown must kill omp's whole process tree.** omp's `bash` tool calls are descendants; leaving them running against a workspace the run has finished with is the failure v1 spent rounds on.
- Errors concerning a specific file, path, model or tool name that thing.
- Tests assert literal expected values, never the implementation's own constants.

---

### Task 1: Plugin skeleton and a working MCP server

Prove the wiring end-to-end with the cheapest possible tool before building anything hard.

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Create: `src/mcp/server.ts`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`)
- Test: `test/mcp-server.test.ts`

**Interfaces:**
- Produces: `export function createServer(): McpServer;` and a stdio entry point.

- [ ] **Step 1: Add the SDK**

```bash
bun add @modelcontextprotocol/sdk
```

- [ ] **Step 2: Write the failing test**

`test/mcp-server.test.ts` — drives the server through the SDK's in-memory transport, so no subprocess and no provider:

```ts
import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([createServer().connect(a), client.connect(b)]);
  return client;
}

test("the server advertises omp_ping", async () => {
  const { tools } = await (await connect()).listTools();
  expect(tools.map(t => t.name)).toContain("omp_ping");
});

test("omp_ping returns the omp version actually installed", async () => {
  const r: any = await (await connect()).callTool({ name: "omp_ping", arguments: {} });
  expect(r.content[0].text).toMatch(/omp\/\d+\.\d+\.\d+/);
});

test("every advertised tool has a description and an input schema", async () => {
  const { tools } = await (await connect()).listTools();
  for (const t of tools) {
    expect(t.description?.length ?? 0).toBeGreaterThan(20);
    expect(t.inputSchema).toBeDefined();
  }
});
```

- [ ] **Step 3: Run it — expect FAIL** (`bun test test/mcp-server.test.ts`, cannot resolve `../src/mcp/server.ts`)

- [ ] **Step 4: Implement `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createServer(): McpServer {
  const server = new McpServer({ name: "omp-dispatch", version: "0.1.0" });

  server.tool(
    "omp_ping",
    "Report the omp version this server will dispatch to. Use to confirm the plugin is wired up.",
    {},
    async () => {
      const out = await Bun.$`omp --version`.nothrow().text();
      return { content: [{ type: "text", text: out.trim() }] };
    },
  );

  return server;
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
```

- [ ] **Step 5: Run tests — expect PASS (3)**

- [ ] **Step 6: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "omp-dispatch",
  "version": "0.1.0",
  "description": "Spawn omp subagents running DeepSeek or GLM in place of native Claude subagents, at a fifth of the token floor. Reads your existing .claude/agents definitions.",
  "author": { "name": "Jamie Steiner" },
  "mcpServers": {
    "omp-dispatch": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts"]
    }
  },
  "skills": "./skills/"
}
```

- [ ] **Step 7: Create `.claude-plugin/marketplace.json`**

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "omp-dispatch",
  "description": "Cheap subagents. Claude supervises, omp executes.",
  "owner": { "name": "Jamie Steiner" },
  "plugins": [
    {
      "name": "omp-dispatch",
      "description": "Drop-in replacement for native Claude subagents, running on omp.",
      "version": "0.1.0",
      "source": "./",
      "category": "development"
    }
  ]
}
```

- [ ] **Step 8: Add a manifest test** to `test/mcp-server.test.ts`:

```ts
test("the plugin manifest declares the MCP server with a plugin-root path", () => {
  const m = JSON.parse(require("node:fs").readFileSync(
    `${import.meta.dir}/../.claude-plugin/plugin.json`, "utf8"));
  const s = m.mcpServers["omp-dispatch"];
  expect(s.command).toBe("bun");
  expect(s.args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
});
```

- [ ] **Step 9: Run the whole suite — 66 prior tests must still pass**

- [ ] **Step 10: Commit**

```bash
git add .claude-plugin src/mcp test/mcp-server.test.ts package.json bun.lock
git commit -m "feat(mcp): plugin manifest and a working MCP server with omp_ping"
```

---

### Task 2: Environment keys and model resolution

**Files:**
- Create: `src/env.ts`, `src/models.ts`
- Test: `test/env.test.ts`, `test/models.test.ts`

**Interfaces:**
```ts
// src/env.ts
export function keyExportsFrom(shellRc: string): Record<string, string>;
export function loadProviderKeys(home?: string): Record<string, string>;

// src/models.ts
export interface TierConfig { tiers: Record<string, string>; default: string; }
export const DEFAULT_TIERS: TierConfig;
export function loadTierConfig(paths: string[]): TierConfig;
export function resolveModel(
  requested: string | undefined,
  cfg: TierConfig,
): string;
```

**Why `src/env.ts` exists — this is load-bearing.** API keys live in `~/.zshrc`, which only sources for interactive shells. The MCP server is launched by Claude Code, not a login shell. Measured: `omp models` from a key-less shell lists **7** providers; with key exports sourced it lists **13**, including `deepseek`. Without this, a dispatch naming `deepseek/deepseek-flash` finds no such provider and either trips the guard or gets fuzzy-routed elsewhere. `~/wiki/scripts/ingest.sh` documents the same trap.

- [ ] **Step 1: Write the failing tests**

`test/env.test.ts`:

```ts
import { test, expect } from "bun:test";
import { keyExportsFrom } from "../src/env.ts";

const RC = [
  `# a comment`,
  `export DEEPSEEK_API_KEY="sk-abc123"`,
  `  export ZAI_API_KEY='zk-def'`,
  `export PATH="/usr/bin:$PATH"`,
  `export SOME_TOKEN=tok-1`,
  `alias ll='ls -la'`,
  `export NOT_A_KEY=nope`,
].join("\n");

test("extracts only API key and token exports", () => {
  const k = keyExportsFrom(RC);
  expect(k.DEEPSEEK_API_KEY).toBe("sk-abc123");
  expect(k.ZAI_API_KEY).toBe("zk-def");
  expect(k.SOME_TOKEN).toBe("tok-1");
});

test("never picks up PATH or unrelated exports", () => {
  const k = keyExportsFrom(RC);
  expect(k.PATH).toBeUndefined();
  expect(k.NOT_A_KEY).toBeUndefined();
});

test("returns an empty object for an rc with no keys", () => {
  expect(keyExportsFrom("echo hello\n")).toEqual({});
});

test("strips both quote styles and leaves bare values alone", () => {
  const k = keyExportsFrom(`export A_API_KEY="q"\nexport B_API_KEY='s'\nexport C_TOKEN=bare`);
  expect([k.A_API_KEY, k.B_API_KEY, k.C_TOKEN]).toEqual(["q", "s", "bare"]);
});
```

`test/models.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolveModel, loadTierConfig, DEFAULT_TIERS } from "../src/models.ts";

test("the shipped defaults are exactly what the spec states", () => {
  expect(DEFAULT_TIERS.tiers.haiku).toBe("deepseek/deepseek-flash");
  expect(DEFAULT_TIERS.tiers.sonnet).toBe("deepseek/deepseek-flash");
  expect(DEFAULT_TIERS.tiers.opus).toBe("zai/glm-5.3");
  expect(DEFAULT_TIERS.default).toBe("sonnet");
});

test("a tier name resolves through the map", () => {
  expect(resolveModel("opus", DEFAULT_TIERS)).toBe("zai/glm-5.3");
});

test("anything that is not a tier is used verbatim", () => {
  expect(resolveModel("zai/glm-4.7", DEFAULT_TIERS)).toBe("zai/glm-4.7");
  expect(resolveModel("ollama/qwen3", DEFAULT_TIERS)).toBe("ollama/qwen3");
});

test("omitting the model uses the default tier", () => {
  expect(resolveModel(undefined, DEFAULT_TIERS)).toBe("deepseek/deepseek-flash");
});

test("a user tier overrides a shipped one and new tiers may be added", () => {
  const cfg = { tiers: { ...DEFAULT_TIERS.tiers, opus: "deepseek/deepseek-v4-pro", thinking: "zai/glm-5.2" }, default: "sonnet" };
  expect(resolveModel("opus", cfg)).toBe("deepseek/deepseek-v4-pro");
  expect(resolveModel("thinking", cfg)).toBe("zai/glm-5.2");
});

test("a later config file overrides an earlier one, key by key", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const d = mkdtempSync(require("node:os").tmpdir() + "/omp-cfg-");
  const user = join(d, "user.json"), proj = join(d, "proj.json");
  writeFileSync(user, JSON.stringify({ tiers: { opus: "zai/glm-5.3", haiku: "a/b" }, default: "sonnet" }));
  writeFileSync(proj, JSON.stringify({ tiers: { opus: "deepseek/deepseek-v4-pro" } }));
  const cfg = loadTierConfig([user, proj]);
  expect(cfg.tiers.opus).toBe("deepseek/deepseek-v4-pro");   // project wins
  expect(cfg.tiers.haiku).toBe("a/b");                        // user survives
});

test("a missing config file is not an error", () => {
  expect(loadTierConfig(["/nope/nothing.json"]).tiers.opus).toBe("zai/glm-5.3");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `src/env.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEY_EXPORT = /^\s*export\s+([A-Z0-9_]*(?:API_KEY|_TOKEN|_KEY))=(.*)$/;

/**
 * Pull only credential exports out of a shell rc. Never eval the whole profile:
 * it drags in prompts, plugins and arbitrary side effects.
 */
export function keyExportsFrom(shellRc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of shellRc.split("\n")) {
    const m = KEY_EXPORT.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (name === "PATH") continue;
    let v = m[2]!.trim().replace(/\s+#.*$/, "");
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v.includes("$")) continue;      // unexpanded reference; not a literal key
    out[name] = v;
  }
  return out;
}

/**
 * The MCP server is launched by Claude Code, not a login shell, so ~/.zshrc has
 * not been sourced. Without these, omp's catalogue is missing every provider
 * whose key lives there — measured: 7 providers instead of 13.
 */
export function loadProviderKeys(home = process.env.HOME ?? ""): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rc of [".zshrc", ".bashrc", ".profile"]) {
    const p = join(home, rc);
    if (!existsSync(p)) continue;
    Object.assign(merged, keyExportsFrom(readFileSync(p, "utf8")));
  }
  // A key already in the real environment wins over one scraped from a file.
  for (const k of Object.keys(merged)) if (process.env[k]) delete merged[k];
  return merged;
}
```

- [ ] **Step 4: Implement `src/models.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";

export interface TierConfig { tiers: Record<string, string>; default: string; }

/**
 * Defaults, not rules. Every one is overridable in config, and any omp model can
 * be named directly at dispatch time or pinned in an agent definition.
 *
 * `deepseek-flash` is deliberate: per DeepSeek's current API docs it is an alias
 * tracking their latest flash model, so this default improves on its own instead
 * of pinning to a version that ages.
 */
export const DEFAULT_TIERS: TierConfig = {
  tiers: {
    haiku: "deepseek/deepseek-flash",
    sonnet: "deepseek/deepseek-flash",
    opus: "zai/glm-5.3",
  },
  default: "sonnet",
};

/** Later paths override earlier ones, key by key. Missing files are skipped. */
export function loadTierConfig(paths: string[]): TierConfig {
  const cfg: TierConfig = { tiers: { ...DEFAULT_TIERS.tiers }, default: DEFAULT_TIERS.default };
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let parsed: Partial<TierConfig>;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`${p}: not valid JSON — ${e instanceof Error ? e.message : e}`);
    }
    Object.assign(cfg.tiers, parsed.tiers ?? {});
    if (parsed.default) cfg.default = parsed.default;
  }
  return cfg;
}

/**
 * Precedence: an explicit non-tier string is a model id and is used verbatim;
 * a tier name resolves through the map; nothing resolves the default tier.
 */
export function resolveModel(requested: string | undefined, cfg: TierConfig): string {
  const key = requested ?? cfg.default;
  return cfg.tiers[key] ?? key;
}
```

- [ ] **Step 5: Run tests — expect PASS (10)**

- [ ] **Step 6: Add `omp_models` to the server**, applying the keys, and a test asserting the provider list is longer with keys than without

- [ ] **Step 7: Run the whole suite, then commit**

```bash
git add src/env.ts src/models.ts test/env.test.ts test/models.test.ts src/mcp/server.ts
git commit -m "feat(models): tier config with user override, and source provider keys the MCP server would otherwise lack"
```

---

### Task 3: `runner.ts` — adapt the broker, drop the daemon

**Files:**
- Create: `src/runner.ts` (adapted from `src/broker.ts`)
- Delete: `src/broker.ts`, `test/broker.test.ts` (superseded)
- Test: `test/runner.test.ts` (port the broker suite)

**Interfaces:**
```ts
export interface RunOptions {
  prompt: string;
  model: string;              // already resolved by src/models.ts
  workdir: string;
  tools: string;
  maxTurns: number;
  maxUsd: number;
  maxSeconds: number;
  systemPrompt?: string;      // agent definition body
  readonly?: string[];        // optional, off by default
  command?: string[];         // tests point this at test/fake-omp.ts
  env?: Record<string, string>;
}
export interface RunHandle {
  runId: string;
  result: RunResult;
  settled: Promise<RunResult>;
  say(text: string): Promise<string>;
  steer(text: string): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export async function startRun(opts: RunOptions, runDir: string, runId: string): Promise<RunHandle>;
```

**What to carry over from `src/broker.ts` unchanged** — these cost four fix rounds and are all still required:
- the `finishing` guard: `client.abort()` provokes a second `agent_end` that double-counts a turn
- turn counting only on `agent_end` where `isTerminal !== false`
- `getSessionStats()` for cost and tool calls, never frame counting
- consecutive stats-failure escalation — a silently stale cost means no budget cap
- the periodic cap poll, so a single long turn cannot escape both caps
- protected teardown: unlock, unsubscribe, clear timers on every exit path
- **killing omp's whole process tree** — its `bash` tool calls are descendants
- handler exceptions routed to teardown (RpcClient calls listeners bare)

**What to drop:** the detached spawn, `broker.pid`, liveness-by-pidfile, the unix socket, and SIGINT/SIGTERM handling. The MCP server is the long-lived owner and disposes handles on shutdown.

- [ ] **Step 1: Port `test/broker.test.ts` to `test/runner.test.ts`**, replacing `runBroker(...)` with `startRun(...)` + `await handle.settled`, and dropping only the pidfile and signal tests.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `src/runner.ts`** from `src/broker.ts`, applying the carry-over list above and deleting the daemon machinery.
- [ ] **Step 4: Add a test proving teardown kills a grandchild** — spawn a long-lived descendant from the fake, dispose, assert the pid is gone. Verify by reverting to a direct-child kill and watching it fail.
- [ ] **Step 5: Delete `src/broker.ts` and `test/broker.test.ts`**
- [ ] **Step 6: Run the whole suite — no count regression**
- [ ] **Step 7: Commit** — `refactor(runner): MCP-owned run lifecycle, replacing the detached broker`

---

### Task 4: `omp_agent` — the tool Claude actually calls

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `src/mcp/runs.ts` (the run registry)
- Test: `test/omp-agent.test.ts`

**Interfaces:**
```ts
// src/mcp/runs.ts
export interface RunRegistry {
  add(name: string, handle: RunHandle): void;
  get(name: string): RunHandle | undefined;
  has(name: string): boolean;
  list(): Array<{ name: string; handle: RunHandle }>;
  remove(name: string): void;
  disposeAll(): Promise<void>;
}
export function createRegistry(): RunRegistry;
export function uniqueName(desc: string, taken: (n: string) => boolean): string;
```

**The signature mirrors the native `Agent` tool deliberately** — same parameter names, so an
existing workflow carries over unchanged:

`omp_agent({ description, prompt, subagent_type?, model?, name?, isolation?, workdir? })`

Returns the agent's final report as text, followed by a compact footer.

**Three requirements that are easy to miss:**

1. **The `model` parameter's description must advertise raw model ids**, not only tiers. If
   the schema mentions only `haiku`/`sonnet`/`opus`, a caller never learns it may pass
   `deepseek/deepseek-v4-pro`, and the most direct control in the design becomes invisible.
   Word it: *"A tier name from your config (haiku, sonnet, opus, or one of your own), or any
   omp model id such as `deepseek/deepseek-v4-pro`. Run `omp_models` to see what is
   available."*
2. **A settled run's omp process survives until `dispose()`** — Task 3 arranged that
   deliberately so Task 8 can resume a completed run. `omp_agent` must therefore dispose any
   handle it does **not** keep in the registry, or every dispatch leaks an omp process.
3. **A cap breach is a result, not an exception.** A run that hits `max_turns` or `max_usd`
   returns its report and footer with `stopped_because` set. Only a failure to *start* is an
   error.

- [ ] **Step 1: Write the failing tests**

Create `test/omp-agent.test.ts`. Drive the MCP server through the in-memory transport the way
`test/mcp-server.test.ts` does, and point every run at `test/fake-omp.ts` through the runner's
`command` option — no provider is contacted.

```ts
test("a dispatch returns the agent's final reply", async () => {});
test("the footer carries turns, cost, tool calls and stop reason", async () => {});
test("a cap breach is reported in the footer, not thrown", async () => {});
test("the model parameter's description advertises raw model ids", async () => {});
test("an explicit model is passed through verbatim, not treated as a tier", async () => {});
test("two concurrent dispatches get distinct names", async () => {});
test("a duplicate explicit name is rejected naming the clash", async () => {});
test("a run that fails to start is an error, not a footer", async () => {});
test("disposeAll settles and disposes every registered run", async () => {});
```

For requirement 2, assert it the way Task 3 asserted teardown: run a dispatch whose fake
spawns a long-lived grandchild, let it settle, call `disposeAll()`, and check the pid is gone.
**A test that only checks the registry is empty proves nothing about the process.**

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `src/mcp/runs.ts`**

`uniqueName` derives a short slug from `description` and appends a counter on collision. An
explicit `name` that is already taken is an **error naming the existing run** — never silently
suffixed, because the caller will use that name with `omp_send_message` and must get the run
it meant.

- [ ] **Step 4: Implement `omp_agent` in `src/mcp/server.ts`**

Resolve the model with `resolveModel` (Task 2), merge `loadProviderKeys()` into the child env,
create the run directory with `createRunDir` (v1 `rundir.ts`), `startRun` (Task 3), `await
handle.settled`, register the handle, then format the report and footer.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Run the whole suite, then commit**

```bash
git add src/mcp test/omp-agent.test.ts
git commit -m "feat(agent): omp_agent dispatches a run and returns its report"
```

---

### Task 5: Stop stripping the subagent's own capabilities

**Files:**
- Modify: `src/runner.ts`
- Test: `test/profile.test.ts`

**The whole change.** `startRun` currently passes `--no-skills --no-rules
--no-extensions` on every dispatch. That was the wiki project's cost-control
posture — strip everything to reach a 10,322-token floor — carried into a general
subagent tool where it does not belong.

**A dispatched agent should use omp's own skills, rules, extensions and MCP
servers.** omp already does that by default. We just have to stop preventing it.

Do not build a capability-configuration subsystem. omp owns that; this tool's job
is the dispatch interface, not re-managing omp's config.

**Keep `--tools=`.** That is not isolation, it is the agent definition's `tools:`
field being honoured, and it is real parity with native subagents.

**Keep `CLAUDE_CONFIG_DIR` pointed at an empty directory.** omp reads external tool
configs (`.claude/`, `.cursor/`) **profile-independently**, so without this a
dispatched agent inherits the host's Claude MCP servers — which is the one thing it
should not have, since those are the 43k-token surface we are not paying for.

- [ ] **Step 1: Write the failing tests**

Create `test/profile.test.ts`. Test the argv construction directly.

```ts
test("skills, rules and extensions are NOT stripped", () => {
  // assert --no-skills, --no-rules and --no-extensions are ABSENT
});
test("the tools allowlist is still passed", () => {});
test("CLAUDE_CONFIG_DIR still points at an empty directory", () => {});
test("--no-lsp and --no-pty are still passed", () => {
  // these are runtime noise, not capabilities; they stay
});
```

**Assert absence, not presence.** The default changed direction, so a test that only
checks a flag appears when asked for would have passed under the old behaviour too.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Extract `buildOmpArgs` from `startRun` in `src/runner.ts`**

The argv is built inline. Pull it into an exported pure function, confirm the suite
passes unchanged, **then** remove the three flags. Extracting before changing keeps
the two risks apart.

- [ ] **Step 4: Remove `--no-skills`, `--no-rules`, `--no-extensions`**

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Run the whole suite, then commit**

```bash
git add src/runner.ts test/profile.test.ts
git commit -m "fix(runner): let a dispatched agent use omp's own skills, rules and extensions"
```

---

### Task 6: Agent definitions — the drop-in core

**Files:** Create `src/agentdef.ts`; Test: `test/agentdef.test.ts`

**Interfaces:**
```ts
export interface AgentDef {
  name: string; description: string; systemPrompt: string;
  ompTools: string[]; droppedTools: string[];
  maxTurns?: number; model?: string; source: string;
}
export const TOOL_MAP: Record<string, string>;
export function translateTools(tools: string[], disallowed: string[]): { ompTools: string[]; dropped: string[] };
export function parseAgentDef(text: string, source: string): AgentDef;
export function discoverAgentDefs(cwd: string, home: string): Map<string, AgentDef>;
```

`TOOL_MAP` (verified against both formats): `Read→read`, `Write→write`, `Edit→edit`, `Bash→bash`, `Grep→grep`, `Glob→glob`, `WebSearch→web_search`, `WebFetch→read` (omp's `read` takes URLs), `NotebookEdit→notebook`, `Agent→task`, `TodoWrite→todo`.

- [ ] **Step 1:** failing tests, including:
  - a real definition from `~/.claude/agents/` parses (`tools: Read, Grep, Glob` → `["read","grep","glob"]`)
  - `disallowedTools` subtracts
  - `tools: []` yields no tools, not all tools
  - `Skill` and an MCP tool name land in `dropped`, not silently vanish
  - project `./.claude/agents/` shadows user `~/.claude/agents/` by name
  - `maxTurns` and `model` are carried through
- [ ] **Step 2:** run, FAIL. **Step 3:** implement. **Step 4:** run, PASS. **Step 5:** commit.

---

### Task 7: Wire agent definitions into `omp_agent`, and refuse on loss

**Files:** Modify `src/mcp/server.ts`; Test: extend `test/omp-agent.test.ts`

**The refusal rule (spec §12.2):** if a definition asks for a tool that cannot be translated, `omp_agent` **fails and names the tools**. No weakened run, no silent fallback to a native subagent. An agent quietly missing the tool it was written around produces confident wrong work.

- [ ] **Step 1:** failing tests — `subagent_type` loads the definition and applies tools, system prompt, `maxTurns` and model; an unknown `subagent_type` errors listing the available names; a definition needing `Skill` is refused with `Skill` in the message; an explicit `model` argument beats the definition's.
- [ ] **Step 2–5:** run FAIL, implement, run PASS, commit.

---

### Task 8: Conversation — the native-parity tools

**Files:** Modify `src/mcp/server.ts`; Test: `test/conversation.test.ts`

`omp_send_message(to, message)`, `omp_steer(to, message)`, `omp_list_agents()`, `omp_task_output(name)`, `omp_task_stop(name)`.

- [ ] **Step 1:** failing tests — a two-turn conversation keeps context; `omp_steer` interrupts mid-turn (assert something only an interrupt produces); `omp_list_agents` shows running and settled runs; `omp_task_output` returns progress for a live run; `omp_task_stop` settles it as aborted; every one of them errors clearly on an unknown name.
- [ ] **Step 2–5:** run FAIL, implement, run PASS, commit.

---

### Task 9: `ask_supervisor` and `omp_answer`

**Files:** Create `src/asktool.ts`; modify `src/runner.ts`, `src/mcp/server.ts`; Test: `test/ask.test.ts`

`RpcClientCustomTool.execute` returns a promise — the runner parks the turn by simply not resolving it until `omp_answer` arrives. No manual frame handling.

- [ ] **Step 1:** failing tests — the tool's schema is right; `execute` parks until answered then returns the answer; answering an unknown id fails; an aborted call rejects rather than hanging; end-to-end, a scripted `askOnTurn` parks the run in state `asking` and `omp_answer` resumes it to completion.
- [ ] **Step 2–5:** run FAIL, implement, run PASS, commit.

---

### Task 10: Worktree isolation

**Files:** Create `src/worktree.ts`; modify `src/mcp/server.ts`; Test: `test/worktree.test.ts`

`isolation: "worktree"` runs `omp worktree add`, points `workdir` at it, and removes it afterwards if unchanged. Default stays `none`, matching native.

- [ ] **Step 1:** failing tests — a worktree run writes into the worktree and leaves the main tree untouched; an unchanged worktree is removed; a worktree with changes is kept and its path reported; a non-repo workdir with `isolation: "worktree"` errors clearly instead of silently running unisolated.
- [ ] **Step 2–5:** run FAIL, implement, run PASS, commit.

---

### Task 11: Skill, shipped agents, README, and the paid smoke test

**Files:** `skills/omp-subagents/SKILL.md`, `agents/{implementer,reviewer,explorer}.md`, `README.md`, `scripts/smoke.sh`

The skill must say plainly **when not to use this**: a task needing Claude's MCP servers, skills or native tools must use a native subagent. That absence is the 43,000-token saving, and it is the only real dividing line.

The README carries a CLAUDE.md snippet the user can paste to make omp subagents the default.

- [ ] **Step 1:** failing packaging tests — manifests valid; skill has front matter with `name` and `description`; the skill names the native-subagent dividing line; every shipped agent definition parses through `parseAgentDef` with no dropped tools.
- [ ] **Step 2:** implement.
- [ ] **Step 3:** run the whole suite.
- [ ] **Step 4: the one paid test.** `scripts/smoke.sh` dispatches a trivial task on `deepseek/deepseek-flash` in a throwaway git repo, asserts the file was written, the footer reports a real cost or a credit-based zero, and the run settled `completed`. Then a second dispatch with `--` a follow-up via `omp_send_message`, asserting turns > 1.
- [ ] **Step 5:** commit.

---

## Self-review notes

**Spec coverage.** §3 packaging → Task 1. §4 tool surface → Task 4, Task 8, Task 9, plus `omp_models` in Task 2. §5 agent definitions and translation → Task 6, Task 7. §6 models, config, key trap → Task 2. §7 isolation → Task 10. §8 reuse → Task 3. §9 turning it on → Task 11. §10 gaps → Task 11's skill. §12.1 tiers → Task 2 defaults. §12.2 refuse → Task 7. §12.3 keep `taskfile.ts` → untouched throughout.

**Type consistency.** `RunResult`, `StoppedBecause`, `CapState` and `Caps` are v1's and unchanged. `RunOptions`, `RunHandle`, `AgentDef` and `TierConfig` are defined once here and used with the same field names throughout.

**The one real risk.** Task 3 is a port of code that took four review rounds to get right. The carry-over list in Task 3 is not advisory — each item is a defect that was found the hard way, and dropping one silently reintroduces it. The ledger at `.superpowers/sdd/2026-09-12-omp-dispatch/progress.md` has the full history if an implementer needs the reasoning.
