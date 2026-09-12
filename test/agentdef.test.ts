import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentDef,
  translateTools,
  discoverAgentDefs,
  TOOL_MAP,
} from "../src/agentdef.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "agents");

// --- translateTools -------------------------------------------------------

test("Claude tool names translate to omp tool names", () => {
  const { ompTools, dropped } = translateTools(["Read", "Grep", "Glob"], []);
  expect(ompTools).toEqual(["read", "grep", "glob"]);
  expect(dropped).toEqual([]);
});

test("disallowedTools subtracts from the allowlist", () => {
  const { ompTools } = translateTools(["Read", "Write", "Bash"], ["Write", "Bash"]);
  expect(ompTools).toEqual(["read"]);
});

test("WebFetch and Read both map to read, de-duplicated", () => {
  const { ompTools } = translateTools(["Read", "WebFetch"], []);
  expect(ompTools).toEqual(["read"]);
});

test("tools with no omp equivalent are reported, never silently discarded", () => {
  const { ompTools, dropped } = translateTools(
    ["Read", "Skill", "ToolSearch", "mcp__foo__bar"],
    [],
  );
  expect(ompTools).toEqual(["read"]);
  expect(dropped).toEqual(["Skill", "ToolSearch", "mcp__foo__bar"]);
});

test("the tool map covers every name the brief specifies", () => {
  expect(TOOL_MAP.Read).toBe("read");
  expect(TOOL_MAP.Write).toBe("write");
  expect(TOOL_MAP.Edit).toBe("edit");
  expect(TOOL_MAP.Bash).toBe("bash");
  expect(TOOL_MAP.Grep).toBe("grep");
  expect(TOOL_MAP.Glob).toBe("glob");
  expect(TOOL_MAP.WebSearch).toBe("web_search");
  expect(TOOL_MAP.WebFetch).toBe("read");
  expect(TOOL_MAP.NotebookEdit).toBe("notebook");
  expect(TOOL_MAP.Agent).toBe("task");
  expect(TOOL_MAP.TodoWrite).toBe("todo");
});

// --- parseAgentDef --------------------------------------------------------

test("parses a real Claude Code agent definition", () => {
  const path = join(FIXTURES, "a2a-answer-t4.md");
  const def = parseAgentDef(readFileSync(path, "utf8"), path);
  expect(def.name).toBe("a2a-answer-t4");
  expect(def.ompTools).toEqual(["read", "grep", "glob"]);
  expect(def.maxTurns).toBe(12);
  expect(def.description).toContain("tier 4");
  expect(def.source).toBe(path);
});

test("tools: [] yields NO tools, not all tools", () => {
  const path = join(FIXTURES, "a2a-answer-t5.md");
  const def = parseAgentDef(readFileSync(path, "utf8"), path);
  expect(def.ompTools).toEqual([]);
  expect(def.maxTurns).toBe(1);
});

test("the body becomes systemPrompt with the front matter excluded", () => {
  const def = parseAgentDef(
    `---\nname: x\ndescription: d\n---\nYou are a reviewer.\n\nSecond line.\n`,
    "/tmp/x.md",
  );
  expect(def.systemPrompt).toBe("You are a reviewer.\n\nSecond line.");
  expect(def.systemPrompt).not.toContain("description:");
});

test("model is carried through when present", () => {
  const def = parseAgentDef(
    `---\nname: x\ndescription: d\nmodel: opus\n---\nbody\n`,
    "/tmp/x.md",
  );
  expect(def.model).toBe("opus");
});

test("model is undefined when absent, not an empty string", () => {
  const def = parseAgentDef(`---\nname: x\ndescription: d\n---\nbody\n`, "/tmp/x.md");
  expect(def.model).toBeUndefined();
});

test("a definition with no front matter is an error naming the file", () => {
  expect(() => parseAgentDef("just text", "/tmp/bad.md")).toThrow(/\/tmp\/bad\.md/);
});

test("a definition with no name is an error naming the file", () => {
  expect(() => parseAgentDef(`---\ndescription: d\n---\nbody\n`, "/tmp/noname.md"))
    .toThrow(/\/tmp\/noname\.md/);
});

test("a non-numeric maxTurns is an error naming the file", () => {
  expect(() =>
    parseAgentDef(`---\nname: x\ndescription: d\nmaxTurns: lots\n---\nbody\n`, "/tmp/mt.md"),
  ).toThrow(/\/tmp\/mt\.md/);
});

// --- discoverAgentDefs ----------------------------------------------------

function tree(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "omp-agentdef-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  return { cwd, home };
}

const def = (name: string, tools = "Read") =>
  `---\nname: ${name}\ndescription: d for ${name}\ntools: ${tools}\n---\nbody\n`;

test("discovers definitions from both project and user directories", () => {
  const { cwd, home } = tree();
  writeFileSync(join(cwd, ".claude", "agents", "p.md"), def("p"));
  writeFileSync(join(home, ".claude", "agents", "u.md"), def("u"));
  const found = discoverAgentDefs(cwd, home);
  expect([...found.defs.keys()].sort()).toEqual(["p", "u"]);
});

test("a project definition shadows a user one of the same name", () => {
  const { cwd, home } = tree();
  writeFileSync(join(cwd, ".claude", "agents", "r.md"), def("r", "Read"));
  writeFileSync(join(home, ".claude", "agents", "r.md"), def("r", "Bash"));
  const found = discoverAgentDefs(cwd, home);
  expect(found.defs.get("r")!.ompTools).toEqual(["read"]);
});

test("a malformed file is skipped without killing discovery of the rest", () => {
  const { cwd, home } = tree();
  writeFileSync(join(cwd, ".claude", "agents", "good.md"), def("good"));
  writeFileSync(join(cwd, ".claude", "agents", "bad.md"), "no front matter here");
  const found = discoverAgentDefs(cwd, home);
  expect(found.defs.has("good")).toBe(true);
  expect(found.errors.length).toBe(1);
  expect(found.errors[0]).toContain("bad.md");
});

test("discovery of a missing directory is not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-agentdef-empty-"));
  const found = discoverAgentDefs(join(root, "nope"), join(root, "alsonope"));
  expect(found.defs.size).toBe(0);
  expect(found.errors).toEqual([]);
});

test("each call returns a fresh map, not a shared instance", () => {
  const { cwd, home } = tree();
  writeFileSync(join(cwd, ".claude", "agents", "a.md"), def("a"));
  const first = discoverAgentDefs(cwd, home);
  first.defs.delete("a");
  expect(discoverAgentDefs(cwd, home).defs.has("a")).toBe(true);
});
