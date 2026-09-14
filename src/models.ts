import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface TierConfig {
  tiers: Record<string, string>;
  default: string;
  /**
   * When set, the only model ids any dispatch may resolve to — the guard
   * behind the tier map, closing the definition-pinned and raw-id paths.
   * Entries are resolved model ids (`deepseek/deepseek-flash`), not tier
   * names. Absent means unrestricted.
   */
  allow?: string[];
}

/**
 * The palette both hosts' callers already know how to pick from — the native
 * vocabulary of each harness, pre-mapped to cheap models, so a calling agent
 * follows its own habits (Claude Code's Agent `model:` field; Codex's
 * spawn_agent `model:` ids) and never deliberates over vendor models, cost or
 * user preference. Omitting `model` — Codex's "inherit" habit — lands on
 * `default`, which is also configured.
 *
 * `deepseek-flash` is deliberate: per DeepSeek's current API docs it is an
 * alias tracking their latest flash model, so this default improves on its
 * own instead of pinning to a version that ages.
 */
export const DEFAULT_TIERS: TierConfig = {
  tiers: {
    // Claude Code's native tier names.
    haiku: "deepseek/deepseek-flash",           // mechanical, copy-out-of-plan
    sonnet: "deepseek/deepseek-flash",          // everyday work, small reviews
    opus: "zai/glm-5.3",                        // final review, hard work
    fable: "zai/glm-5.3",                       // Claude's top tier
    // Codex's native spawn_agent model ids.
    "gpt-5.6-luna": "deepseek/deepseek-flash",  // fast, bounded, mechanical
    "gpt-5.6-terra": "deepseek/deepseek-flash", // general implementation
    "gpt-6-astra": "zai/glm-5.3",               // difficult, high-stakes
  },
  default: "sonnet",
};

/** Later paths override earlier ones, key by key. Missing files are skipped. */
export function loadTierConfig(paths: string[]): TierConfig {
  const cfg: TierConfig = { tiers: { ...DEFAULT_TIERS.tiers }, default: DEFAULT_TIERS.default };
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let parsed: Partial<TierConfig>;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`${p}: not valid JSON — ${e instanceof Error ? e.message : e}`);
    }
    Object.assign(cfg.tiers, parsed.tiers ?? {});
    if (parsed.default) cfg.default = parsed.default;
    if (parsed.allow !== undefined) {
      if (!Array.isArray(parsed.allow) ||
          !parsed.allow.every(v => typeof v === "string" && v.trim() !== "")) {
        throw new Error(`${p}: 'allow' must be an array of model ids, e.g. ["deepseek/deepseek-flash"]`);
      }
      // Replaced, not merged: a project allow list is the tighter policy the
      // user chose for that project, and unioning would silently widen it.
      cfg.allow = parsed.allow.map(v => v.trim());
    }
  }
  return cfg;
}

/**
 * Create `~/.omp-dispatch/config.json` with the shipped palette if — and only
 * if — it does not exist yet. A fresh install otherwise leaves the user with
 * nothing to edit: loadTierConfig silently falls back to in-code defaults, so
 * the file a user is told to configure never comes into being. The MCP
 * server's first start is the install moment (plugin installs run no
 * scripts), so that is when this runs — plus the CLI and doctor, the other
 * two doors.
 *
 * Never overwrites: once the file exists it is the user's, even if it still
 * holds shipped values. Write is tmp-then-rename so a concurrent Claude and
 * Codex start can't observe a half-written config. Write failures (read-only
 * home) are returned, not thrown — the loader's default fallback keeps
 * everything working, so creation is best-effort everywhere but doctor,
 * which reports it.
 */
export function ensureUserConfig(
  home: string,
): { path: string; created: boolean; error?: string } | undefined {
  if (!home) return undefined;
  const dir = join(home, ".omp-dispatch");
  const path = join(dir, "config.json");
  if (existsSync(path)) return { path, created: false };
  try {
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({
      tiers: Object.fromEntries(
        Object.entries(DEFAULT_TIERS.tiers).sort(([a], [b]) => a.localeCompare(b)),
      ),
      default: DEFAULT_TIERS.default,
    }, null, 2) + "\n";
    const tmp = join(dir, `.config.json.tmp-${process.pid}`);
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return { path, created: true };
  } catch (e) {
    return { path, created: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Precedence: an explicit non-tier string is a model id and is used verbatim;
 * a tier name resolves through the map; nothing (or blank) resolves the
 * default tier. Tier values are model ids and are looked up once — a tier
 * value that happens to name another tier is not chased further, it is
 * returned as a literal (would-be) model id. Verbatim ids are the CLI and
 * task-file power path; omp_agent's schema restricts callers to the palette.
 */
export function resolveModel(requested: string | undefined, cfg: TierConfig): string {
  const trimmed = requested?.trim();
  const key = trimmed ? trimmed : cfg.default;
  return cfg.tiers[key] ?? key;
}
