import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDispatchModel } from "../src/dispatch.ts";
import type { AgentDef } from "../src/agentdef.ts";

/**
 * The allow list is the ceiling behind the palette: it must hold for every
 * path a model can arrive by — explicit argument, agent definition, or the
 * configured default — and a refusal must say which one it was, because the
 * fix differs (change the call, the definition, or the config).
 */
function configHome(allow?: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "omp-palette-home-"));
  mkdirSync(join(home, ".omp-dispatch"), { recursive: true });
  if (allow) {
    writeFileSync(join(home, ".omp-dispatch", "config.json"), JSON.stringify({ allow }));
  }
  return home;
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "omp-palette-wd-"));
}

const PINNING_DEF: AgentDef = {
  name: "pinner",
  description: "d",
  systemPrompt: "b",
  ompTools: ["read"],
  droppedTools: [],
  model: "zai/glm-5.3",
  source: "/defs/pinner.md",
};

test("without an allow list nothing is restricted", () => {
  const home = configHome();
  expect(resolveDispatchModel("zai/glm-4.7", undefined, workdir(), home)).toBe("zai/glm-4.7");
});

test("a model on the allow list passes from every origin", () => {
  const home = configHome(["deepseek/deepseek-flash"]);
  expect(resolveDispatchModel("haiku", undefined, workdir(), home)).toBe("deepseek/deepseek-flash");
  expect(resolveDispatchModel(undefined, undefined, workdir(), home)).toBe("deepseek/deepseek-flash"); // default tier
});

test("a disallowed tier is refused naming the model argument", () => {
  const home = configHome(["deepseek/deepseek-flash"]);
  expect(() => resolveDispatchModel("opus", undefined, workdir(), home))
    .toThrow(/the model argument 'opus' resolved to 'zai\/glm-5\.3'.*Allowed models: deepseek\/deepseek-flash/s);
});

test("a definition pinning a disallowed model is refused naming the definition", () => {
  const home = configHome(["deepseek/deepseek-flash"]);
  expect(() => resolveDispatchModel(undefined, PINNING_DEF, workdir(), home))
    .toThrow(/agent definition 'pinner' \(\/defs\/pinner\.md\) setting model: 'zai\/glm-5\.3'/);
});

test("a default tier off the allow list is refused naming the default", () => {
  const home = configHome(["zai/glm-5.3"]);
  // sonnet -> deepseek/deepseek-flash, which this config does not allow.
  expect(() => resolveDispatchModel(undefined, undefined, workdir(), home))
    .toThrow(/the configured default tier 'sonnet' resolved to 'deepseek\/deepseek-flash'/);
});

test("a project config can re-point a tier at an allowed model", () => {
  const home = configHome(["zai/glm-5.3"]);
  const wd = workdir();
  mkdirSync(join(wd, ".omp-dispatch"), { recursive: true });
  writeFileSync(join(wd, ".omp-dispatch", "config.json"),
    JSON.stringify({ tiers: { sonnet: "zai/glm-5.3" } }));
  // The default tier now resolves inside the allow list, so it runs.
  expect(resolveDispatchModel(undefined, undefined, wd, home)).toBe("zai/glm-5.3");
});
