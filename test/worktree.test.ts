import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/worktree.ts";

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "omp-wt-"));
  await Bun.$`git init -q`.cwd(dir).quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await Bun.$`git add -A`.cwd(dir).quiet();
  await Bun.$`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir).quiet();
  return dir;
}

test("a worktree is a real checkout of the repo's contents", async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, "run1");
  expect(existsSync(join(wt.path, "seed.txt"))).toBe(true);
  expect(readFileSync(join(wt.path, "seed.txt"), "utf8")).toBe("seed\n");
  await wt.cleanup();
});

test("writing in the worktree leaves the main tree untouched", async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, "run2");
  writeFileSync(join(wt.path, "agent-wrote.txt"), "hello\n");
  expect(existsSync(join(dir, "agent-wrote.txt"))).toBe(false);
  const main = await Bun.$`git status --porcelain`.cwd(dir).quiet();
  expect(main.stdout.toString().trim()).toBe("");
  await wt.cleanup();
});

test("an unchanged worktree is removed on cleanup", async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, "run3");
  const r = await wt.cleanup();
  expect(r.removed).toBe(true);
  expect(existsSync(wt.path)).toBe(false);
});

test("a worktree with changes is KEPT, and its path reported", async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, "run4");
  writeFileSync(join(wt.path, "work.txt"), "do not delete me\n");
  const r = await wt.cleanup();
  expect(r.removed).toBe(false);
  expect(r.path).toBe(wt.path);
  expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
});

test("a non-repo directory errors clearly instead of running unisolated", async () => {
  const notRepo = mkdtempSync(join(tmpdir(), "omp-wt-bare-"));
  // Assert the ACTIONABLE half of the message: git's own "fatal: not a git
  // repository" would satisfy a bare /git repository/ match, so that alone
  // would pass even with our guard removed.
  await expect(createWorktree(notRepo, "run5")).rejects.toThrow(/run without isolation/);
});

test("two runs get separate worktrees", async () => {
  const dir = await repo();
  const a = await createWorktree(dir, "runA");
  const b = await createWorktree(dir, "runB");
  expect(a.path).not.toBe(b.path);
  writeFileSync(join(a.path, "a.txt"), "a\n");
  expect(existsSync(join(b.path, "a.txt"))).toBe(false);
  await a.cleanup(); await b.cleanup();
});
