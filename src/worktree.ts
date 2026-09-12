import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

export interface Worktree {
  /** Absolute path the run should use as its workdir. */
  path: string;
  /** Remove it if nothing changed; keep and report it if something did. */
  cleanup(): Promise<{ removed: boolean; path: string }>;
}

async function isRepo(dir: string): Promise<boolean> {
  const r = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(dir).nothrow().quiet();
  return r.exitCode === 0;
}

/**
 * Give a run its own checkout, so a dispatched agent can write freely without
 * touching the tree you are working in — the same guarantee native subagents
 * offer as `isolation: "worktree"`.
 *
 * Created with plain `git worktree`, not `omp worktree`: this must work
 * whether or not omp's own worktree settings are configured, and the cleanup
 * rule below is ours rather than omp's.
 */
export async function createWorktree(repoDir: string, runId: string): Promise<Worktree> {
  if (!await isRepo(repoDir)) {
    throw new Error(
      `worktree isolation needs a git repository, and ${repoDir} is not one — ` +
      `run without isolation, or initialise a repo there first.`,
    );
  }

  // Deliberately OUTSIDE the repository. A worktree created inside it shows up
  // as an untracked directory in the parent's `git status`, which both dirties
  // the tree you are working in and corrupts this run's own files_changed —
  // the field the supervisor verifies runs by. A test caught exactly that.
  // Each worktree gets its own uniquely-created parent directory. Keying the
  // path on runId alone inside one shared root was a real defect, caught by a
  // test: `git worktree add` refuses a path that already exists, so leftovers
  // from a crashed run block every later run with the same id, and two repos
  // dispatching the same id would collide outright.
  const root = mkdtempSync(join(tmpdir(), "omp-dispatch-wt-"));
  const path = join(root, runId);
  const branch = `omp-dispatch/${runId}`;
  const add = await Bun.$`git worktree add -b ${branch} ${path} HEAD`
    .cwd(repoDir).nothrow().quiet();
  if (add.exitCode !== 0) {
    throw new Error(
      `failed to create a worktree at ${path}: ${add.stderr.toString().trim()}`,
    );
  }

  return {
    path,
    async cleanup() {
      // "Changed" means the agent left something behind worth keeping. An
      // untouched worktree is noise, so it goes; a dirty one stays, and the
      // caller is told where, because silently deleting an agent's work is
      // the one unrecoverable mistake available here.
      const status = await Bun.$`git status --porcelain`.cwd(path).nothrow().quiet();
      const dirty = status.exitCode !== 0 || status.stdout.toString().trim().length > 0;
      if (dirty) return { removed: false, path };

      await Bun.$`git worktree remove --force ${path}`.cwd(repoDir).nothrow().quiet();
      await Bun.$`git branch -D ${branch}`.cwd(repoDir).nothrow().quiet();
      const removed = !existsSync(path);
      if (removed) rmSync(root, { recursive: true, force: true });
      return { removed, path };
    },
  };
}
