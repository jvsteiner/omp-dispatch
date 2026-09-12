import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";

const openClients: Client[] = [];

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([createServer().connect(a), client.connect(b)]);
  openClients.push(client);
  return client;
}

// Closing the client also closes its linked server-side transport
// (InMemoryTransport.close() closes its paired transport too).
afterEach(async () => {
  await Promise.all(openClients.splice(0).map(c => c.close()));
});

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

test("the plugin manifest declares the MCP server with a plugin-root path", () => {
  const m = JSON.parse(require("node:fs").readFileSync(
    `${import.meta.dir}/../.claude-plugin/plugin.json`, "utf8"));
  const s = m.mcpServers["omp-dispatch"];
  expect(s.command).toBe("bun");
  expect(s.args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
});

test("omp_ping fails clearly when omp is not on PATH", async () => {
  const client = await connect();

  // Isolate PATH to a directory containing only a symlinked `bun`, so bun
  // itself still runs but `omp` cannot be resolved — reproduces "omp missing"
  // without touching the real PATH beyond this one call.
  const binDir = mkdtempSync(join(tmpdir(), "omp-dispatch-nopath-"));
  symlinkSync(process.execPath, join(binDir, "bun"));
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;

  try {
    const r: any = await client.callTool({ name: "omp_ping", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("omp");
  } finally {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  }
});
