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
    if (current === provider && line.includes(id)) return;
  }
  throw new Error(
    `provider '${provider}' does not list model '${id}'.\n` +
    `Usually a missing API key. omp would fall back to another provider's copy ` +
    `without saying so. Refusing to run down a route that was not chosen.`,
  );
}

export async function readModelCatalogue(): Promise<string> {
  return (await Bun.$`omp models`.nothrow().text()) ?? "";
}

function present(workdir: string, rel: string[]): string[] {
  return rel.map(r => join(workdir, r)).filter(p => existsSync(p));
}

/** Make paths read-only at the OS level, before any model exists. */
export async function lockPaths(workdir: string, rel: string[]): Promise<void> {
  for (const p of present(workdir, rel)) await Bun.$`chmod -R a-w ${p}`.nothrow().quiet();
}

/**
 * Restore write permission. Run this at the START of every dispatch too: a
 * previous run killed with -9 never ran its exit trap and left the paths
 * unwritable. Clearing it first stops a stuck state compounding.
 */
export async function unlockPaths(workdir: string, rel: string[]): Promise<void> {
  for (const p of present(workdir, rel)) await Bun.$`chmod -R u+w ${p}`.nothrow().quiet();
}

async function isRepo(workdir: string): Promise<boolean> {
  const r = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(workdir).nothrow().quiet();
  return r.exitCode === 0;
}

function parsePorcelain(text: string): string[] {
  return text.split("\n").map(l => l.slice(3).trim()).filter(Boolean).sort();
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
