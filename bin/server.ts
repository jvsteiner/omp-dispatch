#!/usr/bin/env bun
/**
 * The bundle entry point. `bun run build` bundles this file, src/, the MCP
 * SDK and zod into dist/server.js, which is what both plugin manifests
 * launch. The plugin ships with no node_modules and no install step: the one
 * runtime dependency not in the bundle, omp's RpcClient, is loaded from the
 * omp on PATH (src/ompinstall.ts).
 *
 * One maintenance mode the host (or a supervising agent) can run by hand:
 *
 *   bun dist/server.js --doctor [--workdir <abs path>]
 *                                      check everything a dispatch depends on
 *
 * Everything this prints goes to stderr when serving MCP (the protocol owns
 * stdout); the doctor owns its stdout, since no protocol is attached.
 */
import { runDiagnostics } from "../src/doctor.ts";
import { runStdioServer } from "../src/mcp/server.ts";

const args = process.argv.slice(2);

if (args[0] === "--doctor") {
  const i = args.indexOf("--workdir");
  const workdir = i >= 0 ? args[i + 1] : process.cwd();
  if (!workdir) {
    process.stderr.write("usage: bun dist/server.js --doctor [--workdir <absolute project path>]\n");
    process.exit(2);
  }
  const report = await runDiagnostics(workdir);
  process.stdout.write(report.text + "\n");
  process.exit(report.ok ? 0 : 1);
}

await runStdioServer();
