export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ModelPrice {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export type PricingSource = "custom" | "remote" | "builtin";

export interface PriceResult {
  cost: number;
  isKnown: boolean;
  source: PricingSource | null;
  matchedKey: string | null;
}

// USD per 1M tokens. Source: platform.claude.com/docs/about-claude/pricing (2026-04)
export const BUILTIN_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7":           { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  "claude-opus-4-6":           { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  "claude-sonnet-4-6":         { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  "claude-sonnet-4-5":         { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  "claude-haiku-4-5-20251001": { input:  1.00, output:  5.00, cache_write:  1.25, cache_read: 0.10 },
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
      const k = Object.keys(table).find(k => model.startsWith(k));
      if (k) return { price: table[k], source, key: k };
    }
    return null;
  }

  priceFor(model: string, usage: Usage): PriceResult {
    const hit = this.lookup(model);
    if (!hit) return { cost: 0, isKnown: false, source: null, matchedKey: null };
    const p = hit.price;
    const cost =
      (usage.input_tokens                ?? 0) * p.input       / 1_000_000 +
      (usage.output_tokens               ?? 0) * p.output      / 1_000_000 +
      (usage.cache_creation_input_tokens ?? 0) * p.cache_write / 1_000_000 +
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
    out[model] = {
      input: inp,
      output: outp,
      cache_write: num(v.cache_write) ?? inp,
      cache_read:  num(v.cache_read)  ?? inp * 0.1,
    };
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
}
