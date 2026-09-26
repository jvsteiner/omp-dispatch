# Bundled Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the plugin as one committed bundle, `dist/server.js`, with no `node_modules` and no install step, by loading omp's `RpcClient` from the omp installation already on PATH.

**Architecture:** `bun build` bundles `bin/server.ts`, our `src/`, the MCP SDK and zod into `dist/server.js`. The only thing not bundled is omp's `RpcClient`: it imports omp's native addon at module load, so a bundle that contains it crashes without omp's `node_modules`. `src/ompinstall.ts` finds the `omp` on PATH, resolves `RpcClient` inside that installation, and `src/runner.ts` imports it at runtime. Both manifests launch `dist/server.js`.

**Tech Stack:** Bun 1.4 (`bun build --target=bun`, `Bun.resolveSync`, `Bun.semver`), TypeScript, `bun:test`.

**Spec:** the design below (agreed in conversation, 2026-09-26).

## Design

- Today each installed version carries 862MB of `node_modules`, installed on first start, only so `src/runner.ts` can import `RpcClient` from `@oh-my-pi/pi-coding-agent`.
- A plain bundle fails: `rpc-client.ts` → `@oh-my-pi/pi-utils` → `ptree.ts` → `@oh-my-pi/pi-natives`, which loads a platform `.node` binary at import time (verified: "Failed to load pi_natives native addon for darwin-arm64").
- `omp` on PATH is already a documented requirement (README: "Requires `omp` and `bun` on PATH"). A bun-installed omp is a JS package with its own `node_modules`, including the native addon. Verified on this machine: `realpath $(which omp)` → `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`, and `Bun.resolveSync("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client", <its parent dir>)` resolves to its `src/modes/rpc/rpc-client.ts`, which imports cleanly.
- Side effect: the `RpcClient` in use always matches the `omp` that runs. Today they drift (plugin bundles 18.1.18, PATH has 18.3.1).

## Global Constraints

- Entry point for both hosts: `dist/server.js`. Claude: `${CLAUDE_PLUGIN_ROOT}/dist/server.js`. Codex `.mcp.json`: `"args": ["dist/server.js"], "cwd": "./"`.
- Build command, exactly: `bun build bin/server.ts --target=bun --outfile dist/server.js`. Not minified (stack traces stay readable).
- `dist/server.js` is committed. `.gitignore` must not exclude it.
- `package.json` has no `dependencies`. `@modelcontextprotocol/sdk`, `@oh-my-pi/pi-coding-agent`, `zod`, `@types/bun` are `devDependencies` (build, types, tests).
- Minimum omp: the range already in `package.json` for `@oh-my-pi/pi-coding-agent`, `^18.1.17`.
- `src/doctor.ts` stays importable with no SDK and no `RpcClient` (existing rule in its header comment).
- `src/prune.ts` and `test/prune.test.ts` (uncommitted) are deleted. `--bootstrap`, `installDeps`, `depsInstalled` and the re-exec in `bin/server.ts` are deleted.

## Review Focus

1. **omp installed as a compiled single binary** (no JS package behind it): `realpath` points at a file with no `@oh-my-pi/pi-coding-agent` package above it. Expect `--doctor` FAIL with a fix line, and a dispatch error naming the same fix, not a stack trace. → Task 1, test `locateOmp returns null package for a binary with no package above it`.
2. **omp older than `^18.1.17`** on PATH: `RpcClient` options we pass (`spawn`, `terminationGraceMs`, `customTools`) may not exist. Expect `--doctor` FAIL naming the found and required versions. → Task 1, test `checkOmpVersion fails below the supported range`.
3. **`omp` on PATH is a symlink** (bun global bin, Homebrew). Expect resolution through the link to the real package. → Task 1, test `locateOmp follows a symlinked bin to the package`.
4. **Stale bundle committed**: `src/` changed but `dist/server.js` not rebuilt; users run old code. Expect a failing test. → Task 2, test `dist/server.js is the build of the current source`.
5. **Bundle started with no `node_modules` anywhere near it** (the real marketplace case). Expect `tools/list` to answer and `--doctor` to run. → Task 3 verification, run from a clean copy.

---

### Task 1: Locate omp and load RpcClient from its installation

**Files:**
- Create: `src/ompinstall.ts`
- Modify: `src/runner.ts:3` (static import → runtime load), `src/runner.ts:76-89` (`ompCommand`), `src/runner.ts:339` (`new RpcClient`)
- Modify: `src/doctor.ts:25-40` (`findOmp` → `locateOmp`), plus one new check
- Test: `test/ompinstall.test.ts`, `test/doctor.test.ts` if present, else in `test/ompinstall.test.ts`

**Interfaces:**
- Produces, in `src/ompinstall.ts` (imports only node/bun builtins, so `doctor.ts` may import it):
  - `interface OmpInstall { bin: string; packageRoot: string | null; version: string | null }`
  - `locateOmp(which?: (cmd: string) => string | null): OmpInstall | null` — `null` when `omp` is not on PATH. `bin` is the PATH entry; `packageRoot` is the nearest ancestor of `realpath(bin)` whose `package.json` has `"name": "@oh-my-pi/pi-coding-agent"`, else `null`; `version` is that package's `version`.
  - `rpcClientPath(install: OmpInstall | null): string` — resolves `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client` with `Bun.resolveSync` from `dirname(install.packageRoot)`; when that is unavailable, from `import.meta.dir` (a dev checkout with devDependencies). Throws `Error` whose message contains `omp` and `bun install -g @oh-my-pi/pi-coding-agent` when neither resolves.
  - `checkOmpVersion(version: string | null, range: string): { ok: boolean; detail: string }` — `Bun.semver.satisfies`.
  - `export const OMP_RANGE = "^18.1.17"`
  - `loadRpcClient(): Promise<typeof import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client").RpcClient>` — `await import(rpcClientPath(locateOmp()))`, cached after first success.
- Consumed by: `src/runner.ts` (`loadRpcClient`, `locateOmp`), `src/doctor.ts` (`locateOmp`, `rpcClientPath`, `checkOmpVersion`, `OMP_RANGE`).

- [ ] **Step 1: Write the failing tests** in `test/ompinstall.test.ts`. Build fixtures in a `mkdtempSync` dir: a fake package dir `node_modules/@oh-my-pi/pi-coding-agent/` with `package.json` `{"name":"@oh-my-pi/pi-coding-agent","version":"18.3.1","exports":{"./modes/rpc/*":{"import":"./src/modes/rpc/*.ts"}}}`, a `src/modes/rpc/rpc-client.ts` exporting `export class RpcClient {}`, and `dist/cli.js`.

```ts
test("locateOmp follows a symlinked bin to the package", () => {
  // bin/omp -> ../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js
  const i = locateOmp(() => join(fx, "bin", "omp"))!;
  expect(i.bin).toBe(join(fx, "bin", "omp"));
  expect(i.packageRoot).toBe(realpathSync(join(fx, "node_modules/@oh-my-pi/pi-coding-agent")));
  expect(i.version).toBe("18.3.1");
});
test("locateOmp returns null package for a binary with no package above it", () => {
  const i = locateOmp(() => join(fx, "standalone", "omp"))!;   // plain file
  expect(i.packageRoot).toBeNull();
  expect(i.version).toBeNull();
});
test("locateOmp returns null when omp is not on PATH", () => {
  expect(locateOmp(() => null)).toBeNull();
});
test("rpcClientPath resolves inside the located installation", () => {
  const p = rpcClientPath(locateOmp(() => join(fx, "bin", "omp")));
  expect(p).toBe(join(realpathSync(join(fx, "node_modules/@oh-my-pi/pi-coding-agent")), "src/modes/rpc/rpc-client.ts"));
});
test("checkOmpVersion fails below the supported range", () => {
  expect(checkOmpVersion("18.3.1", OMP_RANGE).ok).toBe(true);
  const low = checkOmpVersion("17.9.0", OMP_RANGE);
  expect(low.ok).toBe(false);
  expect(low.detail).toContain("17.9.0");
  expect(low.detail).toContain("^18.1.17");
  expect(checkOmpVersion(null, OMP_RANGE).ok).toBe(false);
});
```

- [ ] **Step 2: Run** `bun test test/ompinstall.test.ts`. Expected: FAIL, cannot find module `../src/ompinstall.ts`.

- [ ] **Step 3: Implement `src/ompinstall.ts`** per the Interfaces block. `locateOmp` default `which` is `Bun.which`. Walk up from `dirname(realpathSync(bin))` to `/`.

- [ ] **Step 4: Wire `src/runner.ts`.** Replace line 3 with `import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";` and `import { loadRpcClient, locateOmp } from "./ompinstall.ts";`. In `startRun`, before `new RpcClient(...)`: `const RpcClient = await loadRpcClient();`. `ompCommand()`: PATH `bin` from `locateOmp()` first (unchanged behaviour); fallback `["bun", <packageRoot or dev-checkout>/dist/cli.js]`; same error text as today when neither exists.

- [ ] **Step 5: Wire `src/doctor.ts`.** Replace `findOmp` with `locateOmp`. Add one check after the existing `omp` check, label `rpc`: OK `RpcClient from <path>` when `rpcClientPath` resolves and `checkOmpVersion(install.version, OMP_RANGE).ok`; FAIL otherwise, detail = the thrown message or the version detail. Doctor must not import the resolved file (that would load the native addon); resolving the path is the check.

- [ ] **Step 6: Run** `bun test`. Expected: all pass (266 existing + new).

- [ ] **Step 7: Commit** (after the user's go-ahead)

```bash
git add src/ompinstall.ts src/runner.ts src/doctor.ts test/ompinstall.test.ts
git commit -m "feat: load omp's RpcClient from the omp installation on PATH"
```

### Task 2: Build and ship `dist/server.js`

**Files:**
- Modify: `bin/server.ts` (delete `depsInstalled`, `installDeps`, `--bootstrap`, the first-start block and re-exec; import `runStdioServer` statically; update header comment)
- Modify: `package.json` (`scripts.build`; all deps → `devDependencies`)
- Modify: `.claude-plugin/plugin.json`, `.mcp.json` (entry → `dist/server.js`)
- Create: `dist/server.js` (build output, committed)
- Delete: `src/prune.ts`, `test/prune.test.ts`
- Test: `test/packaging.test.ts` (replace test at lines 112-120; add freshness test)

**Interfaces:**
- Consumes: Task 1's runtime `RpcClient` load (the bundle must contain no `pi-natives` loader).
- Produces: `bun run build` → `dist/server.js`.

- [ ] **Step 1: Write the failing tests** in `test/packaging.test.ts`. Replace "the manifest launches the dependency-installing launcher" with:

```ts
test("both manifests launch the committed bundle", () => {
  const claude = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(claude.mcpServers["omp-dispatch"].args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/dist/server.js");
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  expect(mcp.mcpServers["omp-dispatch"].args[0]).toBe("dist/server.js");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.dependencies ?? {}).toEqual({});
});
test("dist/server.js is the build of the current source", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "omp-build-")), "server.js");
  await Bun.$`bun build bin/server.ts --target=bun --outfile ${out}`.cwd(root).quiet();
  expect(readFileSync(join(root, "dist/server.js"), "utf8")).toBe(readFileSync(out, "utf8"));
});
test("the bundle does not contain omp's native addon loader", () => {
  expect(readFileSync(join(root, "dist/server.js"), "utf8")).not.toContain("pi_natives native addon");
});
```

Keep the existing "the two hosts' launch contracts both hold" test; its `existsSync(join(root, entry.cwd, entry.args[0]))` now checks `dist/server.js`.

- [ ] **Step 2: Run** `bun test test/packaging.test.ts`. Expected: FAIL on all three new tests.

- [ ] **Step 3: Implement.** Edit `bin/server.ts`, `package.json`, both manifests; delete the prune files; run `bun run build`. If the freshness test is flaky because the output embeds an absolute path, pin it in the build command and in the test identically (e.g. `--root .`), not by loosening the comparison.

- [ ] **Step 4: Run** `bun test`. Expected: all pass.

- [ ] **Step 5: Commit** (after the user's go-ahead)

```bash
git add bin/server.ts package.json bun.lock .claude-plugin/plugin.json .mcp.json dist/server.js test/packaging.test.ts
git commit -m "feat: ship a single bundled server, no node_modules or install step"
```

### Task 3: Docs and clean-install verification

**Files:**
- Modify: `README.md` (line 92 requirement: omp must be installed with `bun install -g @oh-my-pi/pi-coding-agent`, version `^18.1.17`; line 242: delete the `--bootstrap` sentence; add one line under development: run `bun run build` after changing `src/` or `bin/`, the packaging test fails otherwise)
- Modify: `docs/codex.md` (line 26 `bun install --frozen-lockfile` and lines 55-59 pre-warm: delete; line 206: delete the `--bootstrap` clause)

- [ ] **Step 1: Edit the docs** as listed. Current-state wording only.

- [ ] **Step 2: Clean-copy check.** Copy the tracked files (not `node_modules`) to a scratch dir: `git ls-files -co --exclude-standard | tar cf - -T - | tar xf - -C <scratch>`. Then `rm -rf <scratch>/node_modules` must be a no-op. Run:
  - `bun <scratch>/dist/server.js --doctor --workdir <scratch>` → expected `8/8 checks passed`, with an `rpc` line.
  - MCP `initialize` + `tools/list` over stdio against `bun <scratch>/dist/server.js` → expected the `omp_*` tool names, nothing on stderr.
  - `du -sh <scratch>` → expected a few MB.

- [ ] **Step 3: Real dispatch.** `bun scripts/smoke.ts` spends money (one tiny DeepSeek call). Ask the user before running it. Expected: `PASS`.

- [ ] **Step 4: Commit** (after the user's go-ahead)

```bash
git add README.md docs/codex.md
git commit -m "docs: omp on PATH supplies the RpcClient; no install step"
```
