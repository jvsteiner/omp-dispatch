import { existsSync } from "node:fs";
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

function parsePorcelain(text: string): string[] {
  return text
    .split("\n")
    .map(l => l.slice(3).trim())
    .filter(Boolean)
    .map(p => {
      // A rename/copy line reads "old -> new"; report the destination, since
      // that's the path that actually exists on disk.
      const arrow = p.indexOf(" -> ");
      return arrow < 0 ? p : p.slice(arrow + 4);
    })
    .sort();
}

/** Returns the dirty-file list, or null when workdir is not a git repo. */
export async function gitSnapshot(workdir: string): Promise<string[] | null> {
  if (!await isRepo(workdir)) return null;
  return parsePorcelain(await Bun.$`git status --porcelain`.cwd(workdir).text());
}

/** Files dirty now that were not dirty before. Never trust the agent for this. */
export async function gitChangedSince(
  workdir: string,
  before: string[] | null,
): Promise<string[]> {
  if (before === null) return [];
  const after = parsePorcelain(await Bun.$`git status --porcelain`.cwd(workdir).text());
  const was = new Set(before);
  return after.filter(f => !was.has(f));
}
