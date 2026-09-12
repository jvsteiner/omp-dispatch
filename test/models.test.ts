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
