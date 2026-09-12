import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEY_EXPORT = /^\s*export\s+([A-Z0-9_]*(?:API_KEY|_TOKEN|_KEY))=(.*)$/;

/**
 * Pull only credential exports out of a shell rc. Never eval the whole profile:
 * it drags in prompts, plugins and arbitrary side effects.
 *
 * No PATH special-case: PATH does not end in API_KEY/_TOKEN/_KEY, so the
 * regex never matches it — a guard for that case is unreachable dead code.
 */
export function keyExportsFrom(shellRc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of shellRc.split("\n")) {
    const m = KEY_EXPORT.exec(line);
    if (!m) continue;
    const name = m[1]!;
    let v = m[2]!.trim().replace(/\s+#.*$/, "");
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v.includes("$")) continue;      // unexpanded reference; not a literal key
    out[name] = v;
  }
  return out;
}

/**
 * The MCP server is launched by Claude Code, not a login shell, so ~/.zshrc has
 * not been sourced. Without these, omp's catalogue is missing every provider
 * whose key lives there — measured: 7 providers instead of 13.
 */
export function loadProviderKeys(home = process.env.HOME ?? ""): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rc of [".zshrc", ".bashrc", ".profile"]) {
    const p = join(home, rc);
    if (!existsSync(p)) continue;
    Object.assign(merged, keyExportsFrom(readFileSync(p, "utf8")));
  }
  // A key already in the real environment wins over one scraped from a file.
  for (const k of Object.keys(merged)) if (process.env[k]) delete merged[k];
  return merged;
}
