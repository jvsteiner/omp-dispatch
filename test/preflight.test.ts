import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProviderHasModel, lockPaths, unlockPaths, gitSnapshot, gitChangedSince,
} from "../src/preflight.ts";

// `omp models` prints a provider header line, then its models indented.
const CATALOGUE = [
  "deepseek (2)",
  "  deepseek-v4-flash",
  "  deepseek-v4",
  "openrouter (1)",
  "  deepseek/deepseek-v4-flash",
].join("\n");

test("accepts a model listed under its named provider", () => {
  expect(() => assertProviderHasModel("deepseek/deepseek-v4-flash", CATALOGUE)).not.toThrow();
});

test("rejects a model that only exists under another provider", () => {
  expect(() => assertProviderHasModel("cerebras/deepseek-v4-flash", CATALOGUE))
    .toThrow(/cerebras/);
});

test("skips the check when no provider is named", () => {
  expect(() => assertProviderHasModel("deepseek-v4-flash", CATALOGUE)).not.toThrow();
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

test("git snapshot and diff report only what the run changed", async () => {
  const dir = fixture();
  await Bun.$`git init -q`.cwd(dir);
  await Bun.$`git add -A`.cwd(dir);
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  const before = await gitSnapshot(dir);
  writeFileSync(join(dir, "new.md"), "x");
  const changed = await gitChangedSince(dir, before);
  expect(changed).toEqual(["new.md"]);
});

test("git snapshot returns null outside a repo", async () => {
  expect(await gitSnapshot(fixture())).toBeNull();
});
