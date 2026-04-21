export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface ModelPrice {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export type PricingSource = "custom" | "remote" | "builtin";

export interface PriceResult {
  cost: number;
  isKnown: boolean;
  source: PricingSource | null;
  matchedKey: string | null;
}

// USD per 1M tokens.
// Anthropic source: docs.anthropic.com/en/docs/about-claude/pricing (verified 2026-04-21)
// OpenAI source: openai.com/api/pricing and platform.openai.com/docs/pricing (verified 2026-04-21)
export const BUILTIN_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7":           { input: 15.00, output: 75.00, cache_write_5m: 18.75, cache_write_1h: 30.00, cache_read: 1.50 },
  "claude-opus-4-6":           { input: 15.00, output: 75.00, cache_write_5m: 18.75, cache_write_1h: 30.00, cache_read: 1.50 },
  "claude-opus-4-1":           { input: 15.00, output: 75.00, cache_write_5m: 18.75, cache_write_1h: 30.00, cache_read: 1.50 },
  "claude-opus-4":             { input: 15.00, output: 75.00, cache_write_5m: 18.75, cache_write_1h: 30.00, cache_read: 1.50 },
  "claude-sonnet-4-6":         { input:  3.00, output: 15.00, cache_write_5m:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  "claude-sonnet-4-5":         { input:  3.00, output: 15.00, cache_write_5m:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  "claude-sonnet-4":           { input:  3.00, output: 15.00, cache_write_5m:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  "claude-sonnet-3-7":         { input:  3.00, output: 15.00, cache_write_5m:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  "claude-sonnet-3-5":         { input:  3.00, output: 15.00, cache_write_5m:  3.75, cache_write_1h:  6.00, cache_read: 0.30 },
  "gpt-5.2-chat-latest":       { input:  1.75, output: 14.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.175 },
  "gpt-5.2":                   { input:  1.75, output: 14.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.175 },
  "gpt-5.1-chat-latest":       { input:  1.25, output: 10.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.125 },
  "gpt-5.1":                   { input:  1.25, output: 10.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.125 },
  "gpt-5-chat-latest":         { input:  1.25, output: 10.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.125 },
  "gpt-5":                     { input:  1.25, output: 10.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.125 },
  "gpt-5-mini":                { input:  0.25, output:  2.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.025 },
  "gpt-5-nano":                { input:  0.05, output:  0.40, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.005 },
  "gpt-4.1":                   { input:  2.00, output:  8.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.50 },
  "gpt-4.1-mini":              { input:  0.40, output:  1.60, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.10 },
  "gpt-4.1-nano":              { input:  0.10, output:  0.40, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.025 },
  "gpt-4o":                    { input:  2.50, output: 10.00, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 1.25 },
  "gpt-4o-mini":               { input:  0.15, output:  0.60, cache_write_5m:  0.00, cache_write_1h:  0.00, cache_read: 0.075 },
};

export class PricingTable {
  constructor(
    private custom: Record<string, ModelPrice> = {},
    private remote: Record<string, ModelPrice> = {},
  ) {}

  /** Find price by exact match first, then prefix match. Priority: custom > remote > builtin. */
  lookup(model: string): { price: ModelPrice; source: PricingSource; key: string } | null {
    const tables: Array<[PricingSource, Record<string, ModelPrice>]> = [
      ["custom", this.custom],
      ["remote", this.remote],
      ["builtin", BUILTIN_PRICING],
    ];
    for (const [source, table] of tables) {
      if (table[model]) return { price: table[model], source, key: model };
    }
    for (const [source, table] of tables) {
      const k = longestPrefixMatch(model, Object.keys(table));
      if (k) return { price: table[k], source, key: k };
    }
    return null;
  }

  priceFor(model: string, usage: Usage): PriceResult {
    const hit = this.lookup(model);
    if (!hit) return { cost: 0, isKnown: false, source: null, matchedKey: null };
    const p = hit.price;
    const cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheWriteFallback =
      cacheWrite5m === 0 && cacheWrite1h === 0
        ? (usage.cache_creation_input_tokens ?? 0)
        : 0;
    const cost =
      (usage.input_tokens                ?? 0) * p.input       / 1_000_000 +
      (usage.output_tokens               ?? 0) * p.output      / 1_000_000 +
      cacheWrite5m                           * p.cache_write_5m / 1_000_000 +
      cacheWrite1h                           * p.cache_write_1h / 1_000_000 +
      cacheWriteFallback                     * p.cache_write_5m / 1_000_000 +
      (usage.cache_read_input_tokens     ?? 0) * p.cache_read  / 1_000_000;
    return { cost, isKnown: true, source: hit.source, matchedKey: hit.key };
  }
}

/** Validate user-supplied pricing object; silently drop bad entries. */
export function sanitizePricing(raw: unknown): Record<string, ModelPrice> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModelPrice> = {};
  for (const [model, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    const inp = num(v.input), outp = num(v.output);
    if (inp === null || outp === null) continue;
    const legacyCacheWrite = num(v.cache_write);
    const cacheWrite5m = num(v.cache_write_5m) ?? legacyCacheWrite ?? inp;
    out[model] = {
      input: inp,
      output: outp,
      cache_write_5m: cacheWrite5m,
      cache_write_1h: num(v.cache_write_1h) ?? cacheWrite5m,
      cache_read:  num(v.cache_read)  ?? 0,
    };
  }
  return out;
}

function longestPrefixMatch(model: string, keys: string[]): string | null {
  let best: string | null = null;
  for (const key of keys) {
    if (!model.startsWith(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best;
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
}
