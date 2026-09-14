import { test, expect } from "bun:test";
import { resolveModel, loadTierConfig, DEFAULT_TIERS } from "../src/models.ts";

test("the shipped palette covers both hosts' native model vocabularies", () => {
  // Claude Code's Agent model field...
  expect(DEFAULT_TIERS.tiers.haiku).toBe("deepseek/deepseek-flash");
  expect(DEFAULT_TIERS.tiers.sonnet).toBe("deepseek/deepseek-flash");
  expect(DEFAULT_TIERS.tiers.opus).toBe("zai/glm-5.3");
  expect(DEFAULT_TIERS.tiers.fable).toBe("zai/glm-5.3");
  // ...and Codex's spawn_agent model ids, so neither host's habits break.
  expect(DEFAULT_TIERS.tiers["gpt-5.6-luna"]).toBe("deepseek/deepseek-flash");
  expect(DEFAULT_TIERS.tiers["gpt-5.6-terra"]).toBe("deepseek/deepseek-flash");
  expect(DEFAULT_TIERS.tiers["gpt-6-astra"]).toBe("zai/glm-5.3");
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

test("an allow list is parsed, trimmed, and replaced—not widened—by a later file", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const d = mkdtempSync(require("node:os").tmpdir() + "/omp-allow-");
  const user = join(d, "user.json"), proj = join(d, "proj.json");
  writeFileSync(user, JSON.stringify({ allow: ["deepseek/deepseek-flash", " zai/glm-5.3 "] }));
  writeFileSync(proj, JSON.stringify({ allow: ["zai/glm-5.3"] }));
  expect(loadTierConfig([user]).allow).toEqual(["deepseek/deepseek-flash", "zai/glm-5.3"]);
  // project replaces: unioning would silently widen a tighter project policy.
  expect(loadTierConfig([user, proj]).allow).toEqual(["zai/glm-5.3"]);
  // absent in a later file keeps the earlier one
  writeFileSync(proj, JSON.stringify({ tiers: { opus: "zai/glm-5.3" } }));
  expect(loadTierConfig([user, proj]).allow).toEqual(["deepseek/deepseek-flash", "zai/glm-5.3"]);
});

test("a malformed allow list is refused naming the file", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const d = mkdtempSync(require("node:os").tmpdir() + "/omp-allow-");
  const bad = join(d, "bad.json");
  writeFileSync(bad, JSON.stringify({ allow: ["ok/one", 42, ""] }));
  expect(() => loadTierConfig([bad])).toThrow(new RegExp(bad.replace(/\//g, "\\/")));
});

test("an empty or whitespace-only request falls through to the default tier, not a literal empty model id", () => {
  expect(resolveModel("", DEFAULT_TIERS)).toBe("deepseek/deepseek-flash");
  expect(resolveModel("   ", DEFAULT_TIERS)).toBe("deepseek/deepseek-flash");
});
