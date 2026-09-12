import { readFileSync, existsSync } from "node:fs";

export interface TierConfig { tiers: Record<string, string>; default: string; }

/**
 * Defaults, not rules. Every one is overridable in config, and any omp model can
 * be named directly at dispatch time or pinned in an agent definition.
 *
 * `deepseek-flash` is deliberate: per DeepSeek's current API docs it is an alias
 * tracking their latest flash model, so this default improves on its own instead
 * of pinning to a version that ages.
 */
export const DEFAULT_TIERS: TierConfig = {
  tiers: {
    haiku: "deepseek/deepseek-flash",
    sonnet: "deepseek/deepseek-flash",
    opus: "zai/glm-5.3",
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
  }
  return cfg;
}

/**
 * Precedence: an explicit non-tier string is a model id and is used verbatim;
 * a tier name resolves through the map; nothing resolves the default tier.
 */
export function resolveModel(requested: string | undefined, cfg: TierConfig): string {
  const key = requested ?? cfg.default;
  return cfg.tiers[key] ?? key;
}
