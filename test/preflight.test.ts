import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProviderHasModel, lockPaths, unlockPaths, gitSnapshot, gitDiffSince,
} from "../src/preflight.ts";

// Real `omp models` output: a box-drawn table per provider. Captured from an
// installed omp; full sample at
// .superpowers/sdd/2026-09-12-omp-dispatch/real-omp-models-sample.txt.
// Kept to two providers, trimmed to a few rows each.
const CATALOGUE = [
  "amazon-bedrock (181)",
  "┌──────────────────────────────────────────────────┬─────────┬─────────┬───────────────────────────┬────────┐",
  "│ model                                            │ context │ max-out │ thinking                  │ images │",
  "├──────────────────────────────────────────────────┼─────────┼─────────┼───────────────────────────┼────────┤",
  "│ anthropic.claude-3-5-sonnet-20240620-v1:0        │    200K │    8.2K │ -                         │ yes    │",
  "│ anthropic.claude-3-5-sonnet-20241022-v2:0        │    200K │    8.2K │ -                         │ yes    │",
  "│ anthropic.claude-opus-5                          │      1M │    128K │ low,medium,high,max       │ yes    │",
  "└──────────────────────────────────────────────────┴─────────┴─────────┴───────────────────────────┴────────┘",
  "",
  "bedrock-mantle (5)",
  "┌──────────────────────┬─────────┬─────────┬───────────────────────────┬────────┐",
  "│ model                │ context │ max-out │ thinking                  │ images │",
  "├──────────────────────┼─────────┼─────────┼───────────────────────────┼────────┤",
  "│ openai.gpt-5.4       │    272K │    128K │ low,medium,high,xhigh     │ yes    │",
  "│ openai.gpt-5.5       │    272K │    128K │ low,medium,high,xhigh     │ yes    │",
  "│ openai.gpt-5.6-luna  │    272K │    128K │ low,medium,high,xhigh,max │ yes    │",
  "│ openai.gpt-5.6-sol   │    272K │    128K │ low,medium,high,xhigh,max │ yes    │",
  "│ openai.gpt-5.6-terra │    272K │    128K │ low,medium,high,xhigh,max │ yes    │",
  "└──────────────────────┴─────────┴─────────┴───────────────────────────┴────────┘",
].join("\n");

test("accepts a model listed under its named provider", () => {
  expect(() => assertProviderHasModel("bedrock-mantle/openai.gpt-5.4", CATALOGUE)).not.toThrow();
});

test("rejects a model that only exists under another provider", () => {
  expect(() => assertProviderHasModel("bedrock-mantle/anthropic.claude-opus-5", CATALOGUE))
    .toThrow(/bedrock-mantle/);
});

test("skips the check when no provider is named", () => {
  expect(() => assertProviderHasModel("openai.gpt-5.4", CATALOGUE)).not.toThrow();
});

test("does not accept a short id that is a substring of a longer sibling model", () => {
  // Old bug: line.includes(id) matched "anthropic.claude-3-5-sonnet" inside
  // "anthropic.claude-3-5-sonnet-20240620-v1:0" and the -v2:0 sibling.
  expect(() => assertProviderHasModel("amazon-bedrock/anthropic.claude-3-5-sonnet", CATALOGUE))
    .toThrow(/anthropic\.claude-3-5-sonnet/);
});

test("does not accept a column value that appears in almost every row", () => {
  // Old bug: line.includes(id) matched "yes" against the images column of
  // nearly every row in the block.
  expect(() => assertProviderHasModel("amazon-bedrock/yes", CATALOGUE)).toThrow(/yes/);
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-dispatch-"));
  mkdirSync(join(dir, "raw"));
  writeFileSync(join(dir, "raw", "a.txt"), "a");
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  return dir;
}

test("lock makes paths read-only and unlock restores them", async () => {
  const dir = fixture();
  await lockPaths(dir, ["raw", "CLAUDE.md"]);
  expect(statSync(join(dir, "raw", "a.txt")).mode & 0o200).toBe(0);
  await unlockPaths(dir, ["raw", "CLAUDE.md"]);
  expect(statSync(join(dir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
});

test("unlock repairs paths left locked by a previous kill -9", async () => {
  const dir = fixture();
  await lockPaths(dir, ["raw"]);
  await unlockPaths(dir, ["raw"]);   // stands in for the repair at the top of a run
  await unlockPaths(dir, ["raw"]);   // idempotent
  expect(statSync(join(dir, "raw", "a.txt")).mode & 0o200).not.toBe(0);
});

test("lock ignores a path that does not exist", async () => {
  const dir = fixture();
  await expect(lockPaths(dir, ["nope"])).resolves.toBeUndefined();
});

test("unlock surfaces a real chmod failure instead of swallowing it", async () => {
  const dir = fixture();
  const sub = join(dir, "raw", "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "f.txt"), "x");
  chmodSync(sub, 0o000);   // owner can still set this; no root needed
  await expect(unlockPaths(dir, ["raw"])).rejects.toThrow(/sub/);
  chmodSync(sub, 0o700);   // restore so the fixture dir is left in a sane state
});

test("git snapshot and diff report only what the run changed", async () => {
  const dir = fixture();
  await Bun.$`git init -q`.cwd(dir);
  await Bun.$`git add -A`.cwd(dir);
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  const before = await gitSnapshot(dir);
  writeFileSync(join(dir, "new.md"), "x");
  const d = await gitDiffSince(dir, before);
  expect(d!.files).toEqual(["new.md"]);
  expect(d!.patch).toContain("+x");
});

test("the diff sees an edit to a file that was already dirty at run start", async () => {
  const dir = fixture();
  await Bun.$`git init -q`.cwd(dir);
  writeFileSync(join(dir, "dirty.md"), "one\n");
  await Bun.$`git add -A`.cwd(dir);
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  writeFileSync(join(dir, "dirty.md"), "one\ntwo\n");    // dirty BEFORE the run
  const before = await gitSnapshot(dir);
  writeFileSync(join(dir, "dirty.md"), "one\ntwo\nthree\n");  // the run's edit
  const d = await gitDiffSince(dir, before);
  expect(d!.files).toEqual(["dirty.md"]);
  expect(d!.patch).toContain("+three");
  // the pre-run edit must not be attributed to the run
  expect(d!.patch).not.toContain("+two");
});

test("git snapshot returns null outside a repo", async () => {
  expect(await gitSnapshot(fixture())).toBeNull();
});

test("an unchanged tree diffs to nothing", async () => {
  const dir = fixture();
  await Bun.$`git init -q`.cwd(dir);
  await Bun.$`git add -A`.cwd(dir);
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  const before = await gitSnapshot(dir);
  const d = await gitDiffSince(dir, before);
  expect(d).toEqual({ files: [], patch: "" });
});

test("a rename reports its destination path", async () => {
  const dir = fixture();
  await Bun.$`git init -q`.cwd(dir);
  await Bun.$`git add -A`.cwd(dir);
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  const before = await gitSnapshot(dir);
  await Bun.$`git mv raw/a.txt raw/b.txt`.cwd(dir);
  const d = await gitDiffSince(dir, before);
  expect(d!.files).toEqual(["raw/b.txt"]);
});
