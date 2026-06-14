/**
 * DeepSeek model pricing (USD per million tokens).
 *
 * Automatically converted to CNY in renderDeepSeekUsage when
 * the balance currency is CNY (exchange rate 1:7).
 */
export interface DeepSeekModelPricing {
  input: number;
  output: number;
  cacheRead: number;  // absolute CNY per 1M cache-hit tokens
  cacheWrite: number; // absolute CNY per 1M cache-write tokens (0 = free)
}

export const DEEPSEEK_MODEL_PRICING: Record<string, DeepSeekModelPricing> = {
  "deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cacheWrite: 0,
  },
  "deepseek-v4-flash": {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.028,
    cacheWrite: 0,
  },
};

/**
 * Find deepseek model pricing by normalized model id.
 * The normalized id is lowercased with [._-] → space (same as cost.ts normalizeModelName).
 * Returns null when no matching entry exists.
 */
export function findDeepSeekPricing(modelId: string): DeepSeekModelPricing | null {
  const normalized = modelId.toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  // Direct match
  if (DEEPSEEK_MODEL_PRICING[normalized]) return DEEPSEEK_MODEL_PRICING[normalized];
  // Prefix match (e.g. "deepseek chat" matches "deepseek-chat-20250601")
  for (const [key, pricing] of Object.entries(DEEPSEEK_MODEL_PRICING)) {
    if (normalized.startsWith(key)) return pricing;
  }
  return null;
}
