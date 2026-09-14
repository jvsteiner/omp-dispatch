import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { loadProviderKeys } from "./env.ts";
import { ensureUserConfig, loadTierConfig } from "./models.ts";
import { runsRoot } from "./rundir.ts";
import { discoverAgentDefs } from "./agentdef.ts";
import { pluginVersion } from "./dispatch.ts";

/**
 * Everything a dispatch depends on, checked in one pass. Deliberately
 * importable with no MCP SDK and no omp RPC machinery: `bin/server.ts
 * --doctor` runs this in exactly the states where the server itself cannot
 * start, which is the whole point — a doctor that needs a healthy patient is
 * no doctor.
 *
 * Each check is OK, NOTE (unusual but not broken) or FAIL (a dispatch will
 * not work, or will silently do the wrong thing, until it is fixed).
 */
export interface DoctorReport {
  ok: boolean;
  text: string;
}

/**
 * Mirrors runner.ts's launcher resolution without importing it: PATH first —
 * the documented requirement — then the package-relative fallback for a
 * checkout whose deps are installed but whose binary was never linked.
 * Pulling runner.ts in here would drag the RpcClient along, and doctor must
 * stay loadable when nothing else is.
 */
function findOmp(): { path: string; from: "PATH" | "package" } {
  const onPath = Bun.which("omp");
  if (onPath) return { path: onPath, from: "PATH" };
  return {
    path: Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/dist/cli.js")),
    from: "package",
  };
}

/**
 * omp's own SQLite databases, which a dispatch writes to even when the task
 * itself is read-only: the model catalogue (models.db), session state
 * (agent.db) and usage tracking (stats.db — the numbers the caps are
 * enforced from). `omp --version` touches none of them, so an unwritable or
 * locked database sails past a version check and surfaces later as a
 * mid-dispatch failure.
 */
function ompDatabases(home: string): string[] {
  return [
    join(home, ".omp", "agent", "models.db"),
    join(home, ".omp", "agent", "agent.db"),
    join(home, ".omp", "stats.db"),
  ];
}

/**
 * Proves one SQLite database is writable: takes a write lock, creates and
 * drops a throwaway table inside the transaction, rolls back. Catches the
 * failure modes that break a dispatch — corrupt header, read-only file,
 * another process holding the write lock — without leaving content behind.
 * Returns null when the database is writable, or the failure to report.
 *
 * Two attempts around a short busy_timeout: a concurrent omp process
 * mid-write is normal and transient and must not flunk the doctor.
 */
function probeSqlite(path: string): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: Database | undefined;
    try {
      db = new Database(path);
      db.exec("PRAGMA busy_timeout = 500");
      // A write lock alone (BEGIN IMMEDIATE) can succeed on a connection
      // that has silently fallen back to read-only, because locking is not
      // writing. CREATE + DROP of a throwaway table forces one real page
      // write, and the wrapping transaction rolls it all back either way.
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE _omp_dispatch_doctor_probe(x)");
      db.exec("DROP TABLE _omp_dispatch_doctor_probe");
      db.exec("ROLLBACK");
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt === 1) return message;
      // A plain "locked" is the one retriable answer; anything else
      // (readonly, corrupt, missing header) is deterministic.
      if (!/locked|busy/i.test(message)) return message;
    } finally {
      db?.close();
    }
  }
  return null;
}

export async function runDiagnostics(workdir: string): Promise<DoctorReport> {
  // env.HOME, not os.homedir(): matches env.ts and stays controllable by
  // tests (and by hosts that launch the server under a different HOME).
  const home = process.env.HOME ?? homedir();
  let failures = 0;
  let notes = 0;
  const lines: string[] = [`omp-dispatch ${pluginVersion()} doctor (workdir: ${workdir})`];

  // Three or more call sites need this formatting in lockstep; padding the
  // label keeps the columns readable when a FAIL line is the one that matters.
  const ok = (label: string, detail: string) =>
    lines.push(`  OK   ${label.padEnd(10)} ${detail}`);
  const note = (label: string, detail: string) => {
    notes++;
    lines.push(`  NOTE ${label.padEnd(10)} ${detail}`);
  };
  const fail = (label: string, detail: string) => {
    failures++;
    lines.push(`  FAIL ${label.padEnd(10)} ${detail}`);
  };

  ok("runtime", `bun ${Bun.version}`);

  try {
    const omp = findOmp();
    // Exit status, not just spawn success: an omp that crashes on startup
    // (a corrupt model database among the causes) prints its crash to
    // stderr, exits nonzero, and would otherwise be reported healthy off
    // its --version text alone.
    const r = await Bun.$`${omp.path} --version`.nothrow().quiet();
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString().trim().split("\n").slice(-3).join(" | ");
      fail("omp", `${omp.path} --version exited ${r.exitCode}` +
        (stderr ? `: ${stderr}` : " (no stderr)"));
    } else {
      const version = r.stdout.toString().trim();
      ok("omp", `${version || "present"} (${omp.from}: ${omp.path})`);
    }
  } catch (e) {
    fail("omp", `not resolvable — ${e instanceof Error ? e.message : e}. ` +
      `Install omp and make sure \`omp --version\` works for the process ` +
      `launching this server; hosts do not run a login shell, so tools linked ` +
      `only in ~/.zshrc will not be found.`);
  }

  // Key NAMES only — never values. A provider with no key at all can still be
  // subscription-billed, so absence is a note, not a failure.
  const envKeyNames = Object.keys(process.env)
    .filter(k => /API_KEY$|_TOKEN$|_KEY$/.test(k) && k !== "SSH_KEY" && !k.endsWith("SSH_KEY"))
    .sort();
  const rcKeys = loadProviderKeys(home);
  const rcNames = Object.keys(rcKeys).sort();
  if (envKeyNames.length === 0 && rcNames.length === 0) {
    note("providers", "no provider keys in env or shell rc files — subscription-billed " +
      "auth may still work; run `omp models` (or omp_models) to confirm the catalogue");
  } else {
    ok("providers", `${envKeyNames.length} in env${rcNames.length ? `, ${rcNames.length} sourced from shell rc (${rcNames.join(", ")})` : ""}`);
  }

  try {
    const ensured = ensureUserConfig(home);
    if (ensured?.error) {
      fail("tiers", `could not create ${ensured.path}: ${ensured.error}`);
    } else {
      const cfg = loadTierConfig([
        join(home, ".omp-dispatch", "config.json"),
        join(workdir, ".omp-dispatch", "config.json"),
      ]);
      const def = cfg.tiers[cfg.default] ?? cfg.default;
      ok("tiers", `default ${cfg.default} -> ${def}; palette: ${Object.keys(cfg.tiers).sort().join(", ")}` +
        (cfg.allow ? `; allow: ${cfg.allow.join(", ")}` : "; allow: unrestricted") +
        (ensured?.created ? ` — created ${ensured.path} with the shipped palette, edit it to remap` : ""));
    }
  } catch (e) {
    fail("tiers", String(e instanceof Error ? e.message : e));
  }

  const { defs, errors } = discoverAgentDefs(workdir, home);
  if (errors.length > 0) fail("agents", `parse errors: ${errors.join("; ")}`);
  else if (defs.size === 0) note("agents", "none found (optional) — dispatches run on default tools");
  else ok("agents", `${[...defs.keys()].sort().join(", ")}`);

  const runsDir = runsRoot(workdir);
  try {
    mkdirSync(runsDir, { recursive: true });
    const probe = join(runsDir, ".doctor-probe");
    writeFileSync(probe, "ok");
    rmSync(probe);
    ok("runs dir", `writable: ${runsDir}`);
  } catch (e) {
    fail("runs dir", `not writable: ${runsDir} — ${e instanceof Error ? e.message : e}`);
  }

  // The check --version cannot make: can omp actually WRITE its own state?
  const dbs = ompDatabases(home);
  const present = dbs.filter(existsSync);
  if (present.length === 0) {
    note("databases", `none of omp's exist yet (${dbs.join(", ")}) — created on first use`);
  } else {
    const broken = present
      .map(p => ({ path: p, error: probeSqlite(p) }))
      .filter((r): r is { path: string; error: string } => r.error !== null);
    if (broken.length > 0) {
      for (const b of broken) {
        fail("databases", `${b.path}: ${b.error}`);
      }
    } else {
      ok("databases", `${present.length}/${dbs.length} present, all writable ` +
        `(models.db, agent.db, stats.db)`);
    }
  }

  const total = 7;
  lines.push(
    `doctor: ${total - failures}/${total} checks passed` +
      (notes > 0 ? ` (${notes} note${notes === 1 ? "" : "s"})` : ""),
  );
  return { ok: failures === 0, text: lines.join("\n") };
}
