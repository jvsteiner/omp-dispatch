#!/usr/bin/env bun
/**
 * What the plugin manifest launches, plus two maintenance modes the host (or
 * a supervising agent) can run by hand:
 *
 *   bun bin/server.ts --bootstrap       install dependencies, then exit
 *   bun bin/server.ts --doctor [--workdir <abs path>]
 *                                      check everything a dispatch depends on
 *
 * --doctor deliberately runs BEFORE any dependency check: doctor imports only
 * node/bun builtins and local modules, so it works in exactly the states
 * where the server itself cannot start — which is when it is needed.
 *
 * Everything this prints goes to stderr when serving MCP (the protocol owns
 * stdout); the maintenance modes own their stdout, since no protocol is
 * attached.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { runDiagnostics } from "../src/doctor.ts";

const root = join(dirname(import.meta.path), "..");
const args = process.argv.slice(2);

const depsInstalled = () =>
  existsSync(join(root, "node_modules", "@modelcontextprotocol"));

async function installDeps(): Promise<boolean> {
  process.stderr.write("omp-dispatch: installing dependencies...\n");
  const r = await Bun.$`bun install --frozen-lockfile`.cwd(root).nothrow().quiet();
  if (r.exitCode !== 0) {
    process.stderr.write(
      `omp-dispatch: 'bun install' failed in ${root}.\n` +
      `${r.stderr.toString().trim()}\n` +
      `Fix it by hand with: cd ${root} && bun install\n`,
    );
    return false;
  }
  process.stderr.write("omp-dispatch: dependencies installed\n");
  return true;
}

// Maintenance modes first: neither needs the MCP SDK, and --doctor must not.
if (args[0] === "--bootstrap") {
  process.exit(await installDeps() ? 0 : 1);
}

if (args[0] === "--doctor") {
  const i = args.indexOf("--workdir");
  const workdir = i >= 0 ? args[i + 1] : process.cwd();
  if (!workdir) {
    process.stderr.write("usage: bun bin/server.ts --doctor [--workdir <absolute project path>]\n");
    process.exit(2);
  }
  const report = await runDiagnostics(workdir);
  process.stdout.write(report.text + "\n");
  process.exit(report.ok ? 0 : 1);
}

if (!process.env.OMP_DISPATCH_DEPS_READY && !depsInstalled()) {
  process.stderr.write(
    "omp-dispatch: first start, installing dependencies...\n" +
    "(After an install or an update you can pre-warm this with: " +
    `bun ${join(root, "bin", "server.ts")} --bootstrap — it keeps the install ` +
    "off the host's MCP startup budget.)\n",
  );
  if (!await installDeps()) process.exit(1);

  // Re-exec rather than importing straight on. Bun has already tried and
  // failed to resolve the dependency graph in this process, and the miss is
  // cached — a dynamic import here still fails even though the packages are
  // now on disk. A fresh process resolves cleanly.
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, OMP_DISPATCH_DEPS_READY: "1" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}

// Dynamic on purpose: the SDK import must not resolve until the dependency
// check above has passed (or installed them and re-exec'd) — a static import
// would evaluate before any of this file's logic runs, defeating the
// bootstrap order the whole launcher exists to guarantee.
const { runStdioServer } = await import("../src/mcp/server.ts");
await runStdioServer();
