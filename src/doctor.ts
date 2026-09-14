import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadProviderKeys } from "./env.ts";
import { loadTierConfig } from "./models.ts";
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
    const version = await Bun.$`${omp.path} --version`.nothrow().quiet().text();
    ok("omp", `${version.trim() || "present"} (${omp.from}: ${omp.path})`);
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
    const cfg = loadTierConfig([
      join(home, ".omp-dispatch", "config.json"),
      join(workdir, ".omp-dispatch", "config.json"),
    ]);
    const def = cfg.tiers[cfg.default] ?? cfg.default;
    ok("tiers", `default ${cfg.default} -> ${def}; known: ${Object.keys(cfg.tiers).sort().join(", ")}`);
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

  const total = 6;
  lines.push(
    `doctor: ${total - failures}/${total} checks passed` +
      (notes > 0 ? ` (${notes} note${notes === 1 ? "" : "s"})` : ""),
  );
  return { ok: failures === 0, text: lines.join("\n") };
}
