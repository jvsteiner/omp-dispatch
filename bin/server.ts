#!/usr/bin/env bun
/**
 * What the plugin manifest launches.
 *
 * A marketplace install clones this repository; it does not install
 * dependencies, and `node_modules/` is not committed. Bundling is not an
 * option either — omp's native addon loader resolves its platform binary at
 * runtime and a bundle breaks it. So the dependencies are installed here, once,
 * on the first start after an install or an update.
 *
 * Everything this prints goes to stderr. The MCP protocol owns stdout, and a
 * stray write there corrupts the channel.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const root = join(dirname(import.meta.path), "..");

if (!process.env.OMP_DISPATCH_DEPS_READY &&
    !existsSync(join(root, "node_modules", "@modelcontextprotocol"))) {
  process.stderr.write("omp-dispatch: first start, installing dependencies...\n");
  const r = await Bun.$`bun install --frozen-lockfile`.cwd(root).nothrow().quiet();
  if (r.exitCode !== 0) {
    process.stderr.write(
      `omp-dispatch: 'bun install' failed in ${root}.\n` +
      `${r.stderr.toString().trim()}\n` +
      `Fix it by hand with: cd ${root} && bun install\n`,
    );
    process.exit(1);
  }
  process.stderr.write("omp-dispatch: dependencies installed\n");

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

const { runStdioServer } = await import("../src/mcp/server.ts");
await runStdioServer();
