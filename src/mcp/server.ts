import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadProviderKeys } from "../env.ts";

export function createServer(): McpServer {
  const server = new McpServer({ name: "omp-dispatch", version: "0.1.0" });

  server.tool(
    "omp_ping",
    "Report the omp version this server will dispatch to. Use to confirm the plugin is wired up.",
    {},
    async () => {
      // .quiet() stops the child's stdout/stderr from leaking onto our own —
      // this server talks JSON-RPC over stdout, so nothing else may write there.
      const result = await Bun.$`omp --version`.nothrow().quiet();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(
          `omp_ping failed: 'omp' did not run successfully (exit code ${result.exitCode}).` +
            (stderr ? ` ${stderr}` : " Check that omp is installed and on PATH."),
        );
      }
      return { content: [{ type: "text", text: result.stdout.toString().trim() }] };
    },
  );

  server.tool(
    "omp_models",
    "List omp's model catalogue. Applies provider API keys sourced from the " +
      "user's shell rc files first, since this server is launched by Claude " +
      "Code rather than a login shell and would otherwise miss any provider " +
      "whose key lives only in ~/.zshrc, ~/.bashrc or ~/.profile.",
    {},
    async () => {
      // .quiet() stops the child's stdout/stderr from leaking onto our own —
      // this server talks JSON-RPC over stdout, so nothing else may write there.
      const result = await Bun.$`omp models`
        .env({ ...process.env, ...loadProviderKeys() })
        .nothrow()
        .quiet();
      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(
          `omp_models failed: 'omp models' did not run successfully (exit code ${result.exitCode}).` +
            (stderr ? ` ${stderr}` : " Check that omp is installed and on PATH."),
        );
      }
      return { content: [{ type: "text", text: result.stdout.toString().trim() }] };
    },
  );

  return server;
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
