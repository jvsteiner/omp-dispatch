import type { RunHandle } from "../runner.ts";

/**
 * The MCP server's in-memory `Map<name, RunHandle>`. A run stays here after it
 * settles — deliberately: Task 3 leaves a settled run's omp process alive
 * until dispose() so a later omp_send_message can resume it. Whatever calls
 * add() is therefore responsible for dispose()ing any handle it decides NOT
 * to keep here; disposeAll() only reaches what was actually added.
 */
export interface RunRegistry {
  add(name: string, handle: RunHandle): void;
  get(name: string): RunHandle | undefined;
  has(name: string): boolean;
  list(): Array<{ name: string; handle: RunHandle }>;
  remove(name: string): void;
  disposeAll(): Promise<void>;
}

export function createRegistry(): RunRegistry {
  const runs = new Map<string, RunHandle>();
  return {
    add(name: string, handle: RunHandle): void {
      runs.set(name, handle);
    },
    get(name: string): RunHandle | undefined {
      return runs.get(name);
    },
    has(name: string): boolean {
      return runs.has(name);
    },
    list(): Array<{ name: string; handle: RunHandle }> {
      return [...runs.entries()].map(([name, handle]) => ({ name, handle }));
    },
    remove(name: string): void {
      runs.delete(name);
    },
    async disposeAll(): Promise<void> {
      // Snapshot and clear first: a handle mid-dispose must not still be
      // reachable through get()/has() as if it were live.
      const handles = [...runs.values()];
      runs.clear();
      await Promise.all(handles.map(h => h.dispose()));
    },
  };
}

/**
 * Derives a short slug from a free-text description and appends a counter on
 * collision (`slug`, then `slug-2`, `slug-3`, ...). Never used for an
 * explicit name: a caller-chosen name that is already taken is an error
 * naming the existing run, not something this silently resolves around — the
 * caller will use that name with omp_send_message and must get the run it
 * meant.
 */
export function uniqueName(desc: string, taken: (n: string) => boolean): string {
  const slug =
    desc
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent";
  if (!taken(slug)) return slug;
  let n = 2;
  while (taken(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}
