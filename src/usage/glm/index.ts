import type { UsageData, UsagePlatform } from '../../types.js';
import { detectPlatform, getGlmBaseDomain } from '../../glm-detect.js';
import { fetchFull, getGlmHeaders } from './api.js';
import type { FetchedData } from './types.js';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const MIN_TOKENS_FOR_7D = 1000;

export interface GlmUsageDeps {
  detectPlatform: () => UsagePlatform;
  getGlmBaseDomain: () => string | null;
  fetchFull: (baseDomain: string, headers: Record<string, string>) => Promise<FetchedData>;
  getGlmHeaders: () => Record<string, string> | null;
}

const defaultDeps: GlmUsageDeps = {
  detectPlatform: () => detectPlatform(),
  getGlmBaseDomain: () => getGlmBaseDomain(),
  fetchFull,
  getGlmHeaders,
};

/**
 * Fetch current GLM usage directly from the API on every call.
 *
 * No cross-invocation cache: each statusline refresh requests fresh quota +
 * 7d/5h model-usage. Returns null when the platform is not GLM, the base
 * domain/headers are unavailable, the API returns no usable data, or the
 * request fails.
 */
export async function getGlmUsage(overrides?: Partial<GlmUsageDeps>): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };

  if (deps.detectPlatform() !== 'glm') return null;

  const baseDomain = deps.getGlmBaseDomain();
  if (!baseDomain) return null;
  const headers = deps.getGlmHeaders();
  if (!headers) return null;

  try {
    const fetched = await deps.fetchFull(baseDomain, headers);
    const tokens7d = fetched.tokens7d;

    // 7d% from API weekly percentage (unit:6) — no EMA calibration
    let sevenDay: number | null = fetched.weeklyPct ?? null;
    let sevenDayTokens: number | undefined;
    if (sevenDay != null && tokens7d >= MIN_TOKENS_FOR_7D) {
      sevenDayTokens = tokens7d;
    } else if (sevenDay === null && tokens7d >= MIN_TOKENS_FOR_7D) {
      // 无 unit:6 周限额 → 退化为自然周 token（sevenDay=null，显示累计 token）
      sevenDayTokens = tokens7d;
    }

    if (fetched.fiveHourPct === null && sevenDay === null && sevenDayTokens === undefined) return null;

    const sevenDayResetAt = fetched.weeklyResetTime ?? null;
    const sevenDayStartAt = sevenDayResetAt != null ? sevenDayResetAt - 7 * 24 * 60 * 60 * 1000 : null;
    const fiveHourResetAt = fetched.tokensLimitResetTime ?? null;
    const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : null;

    return {
      fiveHour: fetched.fiveHourPct,
      sevenDay,
      fiveHourStartAt: fiveHourStartAt != null ? new Date(fiveHourStartAt) : null,
      fiveHourResetAt: fiveHourResetAt != null ? new Date(fiveHourResetAt) : null,
      sevenDayStartAt: sevenDayStartAt != null ? new Date(sevenDayStartAt) : null,
      sevenDayResetAt: sevenDayResetAt != null ? new Date(sevenDayResetAt) : null,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: sevenDay !== null ? 'cycle' : (sevenDayTokens !== undefined ? 'rolling' : undefined),
      platform: 'glm',
      sevenDayTokens,
    };
  } catch {
    return null;
  }
}
