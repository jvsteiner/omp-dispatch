import { test, expect } from "bun:test";
import { parseTaskFile, TASK_DEFAULTS } from "../src/taskfile.ts";

const opts = { taskPath: "/tmp/t.md", rolesDir: "/tmp/roles" };

test("parses front matter and body", () => {
  const spec = parseTaskFile(
    `---\nmodel: deepseek/deepseek-v4-flash\nworkdir: /tmp/w\nmax_usd: 2.5\n---\nDo the thing.\n`,
    opts,
  );
  expect(spec.model).toBe("deepseek/deepseek-v4-flash");
  expect(spec.workdir).toBe("/tmp/w");
  expect(spec.maxUsd).toBe(2.5);
  expect(spec.body).toBe("Do the thing.");
});

test("applies defaults for omitted keys", () => {
  const spec = parseTaskFile(`---\nmodel: m\nworkdir: /tmp/w\n---\nbody\n`, opts);
  expect(spec.maxTurns).toBe(TASK_DEFAULTS.maxTurns);
  expect(spec.maxSeconds).toBe(TASK_DEFAULTS.maxSeconds);
  expect(spec.tools).toBe(TASK_DEFAULTS.tools);
  expect(spec.readonly).toEqual([]);
});

test("parses a readonly list", () => {
  const spec = parseTaskFile(
    `---\nmodel: m\nworkdir: /tmp/w\nreadonly: [raw, schema, CLAUDE.md]\n---\nbody\n`,
    opts,
  );
  expect(spec.readonly).toEqual(["raw", "schema", "CLAUDE.md"]);
});

test("rejects a missing model", () => {
  expect(() => parseTaskFile(`---\nworkdir: /tmp/w\n---\nbody\n`, opts)).toThrow(/model/);
});

test("rejects a relative workdir", () => {
  expect(() => parseTaskFile(`---\nmodel: m\nworkdir: rel\n---\nbody\n`, opts)).toThrow(/absolute/);
});

test("rejects an empty body", () => {
  expect(() => parseTaskFile(`---\nmodel: m\nworkdir: /tmp/w\n---\n\n`, opts)).toThrow(/body/);
});

test("rejects a file with no front matter", () => {
  expect(() => parseTaskFile(`just a prompt`, opts)).toThrow(/front matter/);
});

test("a role supplies defaults and the task file overrides them", () => {
  const spec = parseTaskFile(
    `---\nmodel: m\nworkdir: /tmp/w\nrole: ingest\nmax_usd: 0.25\n---\nbody\n`,
    { taskPath: "/tmp/t.md", rolesDir: `${import.meta.dir}/../roles` },
  );
  expect(spec.maxTurns).toBe(150);   // from the role
  expect(spec.maxUsd).toBe(0.25);    // task file wins
});
