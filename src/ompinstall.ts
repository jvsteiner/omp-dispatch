import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

/**
 * Where omp's RpcClient comes from at runtime: the omp installation on PATH.
 *
 * The plugin ships as one bundle with no node_modules. RpcClient cannot go in
 * that bundle — it imports omp's native addon (@oh-my-pi/pi-natives, via
 * pi-utils' ptree) at module load, and the addon is a per-platform binary
 * that lives in omp's own node_modules. omp on PATH is already a hard
 * requirement, and a bun-installed omp is a JS package carrying exactly that
 * binary, so the RpcClient is imported from there. It also keeps the client
 * in lockstep with the omp that actually runs.
 *
 * Builtins only: doctor.ts imports this, and doctor must load when nothing
 * else does. Resolving a path never loads the addon; only loadRpcClient does.
 */
export interface OmpInstall {
  /** The PATH entry, as found. */
  bin: string;
  /** The @oh-my-pi/pi-coding-agent package behind it, or null for a compiled omp. */
  packageRoot: string | null;
  version: string | null;
}

/** The omp versions whose RpcClient takes the options runner.ts passes. */
export const OMP_RANGE = "^18.1.17";

const PACKAGE = "@oh-my-pi/pi-coding-agent";
const RPC_CLIENT = `${PACKAGE}/modes/rpc/rpc-client`;

/** Every `omp` on PATH, in PATH order — not just the first, see locateOmp. */
function ompsOnPath(): string[] {
  const found: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, "omp");
    try {
      accessSync(bin, constants.X_OK);
      if (!found.includes(bin)) found.push(bin);
    } catch { /* not here */ }
  }
  return found;
}

function inspect(bin: string): OmpInstall {
  let dir: string;
  try {
    dir = dirname(realpathSync(bin));
  } catch {
    return { bin, packageRoot: null, version: null };
  }
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === PACKAGE) {
          return { bin, packageRoot: dir, version: typeof pkg.version === "string" ? pkg.version : null };
        }
      } catch { /* unreadable manifest: keep walking */ }
    }
    const up = dirname(dir);
    if (up === dir) return { bin, packageRoot: null, version: null };
    dir = up;
  }
}

/**
 * The omp a dispatch uses: the first JS install on PATH, else the first omp
 * of any kind (which rpcClientPath then refuses with a fix). Not simply the
 * first on PATH — Homebrew's compiled omp commonly shadows ~/.bun/bin, and
 * the runner spawns this bin AND loads the RpcClient beside it, so the two
 * must come from the same install.
 */
export function locateOmp(candidates: () => string[] = ompsOnPath): OmpInstall | null {
  const installs = candidates().map(inspect);
  return installs.find(i => i.packageRoot) ?? installs[0] ?? null;
}

/**
 * The RpcClient module inside the located installation. Only with no omp on
 * PATH at all does it fall back to a resolution from this file — a dev
 * checkout with devDependencies, where tests drive a fake omp. A compiled
 * omp never falls back: a leftover node_modules beside the plugin would hand
 * it an RpcClient of some other version.
 */
export function rpcClientPath(install: OmpInstall | null): string {
  const from = install ? (install.packageRoot ? dirname(install.packageRoot) : null) : import.meta.dir;
  if (from) {
    try {
      return Bun.resolveSync(RPC_CLIENT, from);
    } catch { /* reported below */ }
  }
  throw new Error(notLoadable(install));
}

function notLoadable(install: OmpInstall | null): string {
  return install
    ? `omp at ${install.bin} is not a JS install, so its RpcClient cannot be loaded. ` +
      `Install omp with: bun install -g ${PACKAGE}`
    : `cannot find omp on PATH. Install it with: bun install -g ${PACKAGE}`;
}

export function checkOmpVersion(version: string | null, range: string): { ok: boolean; detail: string } {
  if (!version) return { ok: false, detail: `omp version unknown; this plugin needs omp ${range}` };
  return Bun.semver.satisfies(version, range)
    ? { ok: true, detail: `omp ${version} satisfies ${range}` }
    : { ok: false, detail: `omp ${version} is outside ${range}. Update it with: bun install -g ${PACKAGE}` };
}

/** The doctor's view: can a dispatch load an RpcClient that fits? */
export function rpcCheck(install: OmpInstall | null): { ok: boolean; detail: string } {
  if (!install?.packageRoot) return { ok: false, detail: notLoadable(install) };
  const version = checkOmpVersion(install.version, OMP_RANGE);
  if (!version.ok) return version;
  try {
    return { ok: true, detail: `RpcClient from ${rpcClientPath(install)} (${version.detail})` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// Keyed by path: an omp upgraded mid-session resolves to the same path, but
// switching installs does not reuse the wrong client. A failure is never
// cached — the user can fix it without restarting the server.
const cache = new Map<string, typeof RpcClient>();

export async function loadRpcClient(install: OmpInstall | null = locateOmp()): Promise<typeof RpcClient> {
  // The options runner.ts passes (spawn, terminationGraceMs, customTools)
  // are ignored, not rejected, by an RpcClient that predates them — so an
  // out-of-range omp is refused here rather than run degraded.
  if (install?.packageRoot) {
    const v = checkOmpVersion(install.version, OMP_RANGE);
    if (!v.ok) throw new Error(v.detail);
  }
  const path = rpcClientPath(install);
  const hit = cache.get(path);
  if (hit) return hit;
  const mod = await import(path);
  cache.set(path, mod.RpcClient as typeof RpcClient);
  return mod.RpcClient as typeof RpcClient;
}
