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

test("the plugin manifest declares the MCP server with a plugin-root path", () => {
  const m = JSON.parse(require("node:fs").readFileSync(
    `${import.meta.dir}/../.claude-plugin/plugin.json`, "utf8"));
  const s = m.mcpServers["omp-dispatch"];
  expect(s.command).toBe("bun");
  expect(s.args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
});
