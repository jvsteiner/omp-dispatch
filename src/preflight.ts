import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * omp matches model ids fuzzily and will route "deepseek/x" through another
 * provider's copy when the named provider has no key. Assert against the
 * catalogue, never by sending a prompt.
 */
export function assertProviderHasModel(model: string, catalogue: string): void {
  const slash = model.indexOf("/");
  if (slash < 0) return;                       // no provider named; nothing to assert
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);

  let current = "";
  for (const line of catalogue.split("\n")) {
    const header = /^([a-z0-9-]+) \(\d+\)$/.exec(line.trim());
    if (header && !line.startsWith(" ")) { current = header[1]!; continue; }
    if (current !== provider) continue;

    // Match the model id as the whole first cell, never as a substring
    // anywhere in the row: borders, the column header, and other columns
    // ("yes", "200K", ...) would otherwise false-match almost any row, and a
    // short id would false-match a longer sibling that merely starts with it.
    const trimmed = line.trim();
    if (trimmed.startsWith("│")) {
      if (trimmed.split("│")[1]?.trim() === id) return;
    } else if (trimmed === id) {
      return;                                  // fallback: a plain indented model line
    }
  }
  throw new Error(
    `provider '${provider}' does not list model '${id}'.\n` +
    `Usually a missing API key. omp would fall back to another provider's copy ` +
    `without saying so. Refusing to run down a route that was not chosen.`,
  );
}

export async function readModelCatalogue(): Promise<string> {
  return await Bun.$`omp models`.nothrow().text();
}

function present(workdir: string, rel: string[]): string[] {
  return rel.map(r => join(workdir, r)).filter(p => existsSync(p));
}

/**
 * Run `chmod -R <mode>` over the paths in `rel` that exist. A missing path is
 * silently skipped (filtered by `present`), but a chmod that fails on a path
 * that *does* exist is a real error (permission denied, read-only mount) and
 * must not be swallowed — it surfaces naming the path that failed.
 */
async function chmodPresent(workdir: string, rel: string[], mode: string, verb: string): Promise<void> {
  for (const p of present(workdir, rel)) {
    const r = await Bun.$`chmod -R ${mode} ${p}`.nothrow().quiet();
    if (r.exitCode !== 0) {
      throw new Error(`failed to ${verb} '${p}': ${r.stderr.toString().trim()}`);
    }
  }
}

/** Make paths read-only at the OS level, before any model exists. */
export async function lockPaths(workdir: string, rel: string[]): Promise<void> {
  await chmodPresent(workdir, rel, "a-w", "lock");
}

/**
 * Restore write permission. Run this at the START of every dispatch too: a
 * previous run killed with -9 never ran its exit trap and left the paths
 * unwritable. Clearing it first stops a stuck state compounding.
 */
export async function unlockPaths(workdir: string, rel: string[]): Promise<void> {
  await chmodPresent(workdir, rel, "u+w", "unlock");
}

async function isRepo(workdir: string): Promise<boolean> {
  const r = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(workdir).nothrow().quiet();
  return r.exitCode === 0;
}

/**
 * Captures the FULL current content of a worktree — tracked and untracked,
 * clean and dirty alike — as one tree sha, without touching the real index,
 * the working tree, or anything the user (or a concurrent run) might be
 * doing. `git-stash`'s own trick: a throwaway GIT_INDEX_FILE seeded from
 * nothing, `add -A` into it, `write-tree` out of it.
 *
 * A name-list snapshot (the old approach) could not see an edit to a file
 * that was ALREADY dirty when the run started — exactly the file a shared
 * workdir dispatch is most likely to touch. A tree snapshot can: the diff
 * between two trees is by content, not by status.
 */
export interface GitSnapshot { tree: string }

export async function gitSnapshot(workdir: string): Promise<GitSnapshot | null> {
  if (!await isRepo(workdir)) return null;
  const tmpIndex = mkdtempSync(join(tmpdir(), "omp-dispatch-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpIndex, "index") };
    const add = await Bun.$`git add -A`.cwd(workdir).env(env).nothrow().quiet();
    if (add.exitCode !== 0) {
      throw new Error(`git add -A failed in ${workdir}: ${add.stderr.toString().trim()}`);
    }
    const tree = (await Bun.$`git write-tree`.cwd(workdir).env(env).quiet().text()).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error(`unexpected git write-tree output in ${workdir}: ${tree}`);
    }
    return { tree };
  } finally {
    rmSync(tmpIndex, { recursive: true, force: true });
  }
}

/**
 * What changed between a snapshot and now: the file list and the patch.
 * git-derived, never taken from the agent's account of itself. Null when
 * there was no baseline (not a repo); empty lists when nothing changed.
 */
export async function gitDiffSince(
  workdir: string,
  before: GitSnapshot | null,
): Promise<{ files: string[]; patch: string } | null> {
  if (before === null) return null;
  const after = await gitSnapshot(workdir);
  if (!after || after.tree === before.tree) return { files: [], patch: "" };
  // -M so a pure rename reads as its destination path, not as a delete-plus-
  // add pair — the path that actually exists on disk is the useful one.
  const files = (await Bun.$`git diff --name-only -M ${before.tree} ${after.tree}`
    .cwd(workdir).quiet().text())
    .split("\n").filter(Boolean).sort();
  const patch = await Bun.$`git diff -M ${before.tree} ${after.tree}`
    .cwd(workdir).quiet().text();
  return { files, patch };
}
