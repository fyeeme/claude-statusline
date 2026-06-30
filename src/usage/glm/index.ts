import type { UsageData, UsagePlatform } from '../../types.js';
import { detectPlatform, getGlmBaseDomain } from '../../glm-detect.js';
import { fetch5hTokens, fetchModelUsage, fetchQuotaOnly, getGlmHeaders } from './api.js';
import type { QuotaInfo } from './api.js';
import { getNaturalWeekRange, resolveTimezone } from './timezone.js';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Path A window `endMs` for model-usage aggregation.
 *
 * Validated (real account): the model-usage API accepts a future `endTime`
 * equal to `unit:6.nextResetTime`, so the token window is the full cycle
 * `[nextResetTime - 7d, nextResetTime]`, aligning exactly with `percentage`
 * (which is the whole-cycle cumulative value).
 */
const USE_NOW_FOR_PATH_A_END = false;

export interface GlmUsageDeps {
  detectPlatform: () => UsagePlatform;
  getGlmBaseDomain: () => string | null;
  fetchQuotaOnly: (baseDomain: string, headers: Record<string, string>) => Promise<QuotaInfo>;
  fetchModelUsage: (baseDomain: string, headers: Record<string, string>, startMs: number, endMs: number) => Promise<number>;
  fetch5hTokens: (baseDomain: string, headers: Record<string, string>, resetTime: number | null) => Promise<number>;
  getGlmHeaders: () => Record<string, string> | null;
}

const defaultDeps: GlmUsageDeps = {
  detectPlatform: () => detectPlatform(),
  getGlmBaseDomain: () => getGlmBaseDomain(),
  fetchQuotaOnly,
  fetchModelUsage,
  fetch5hTokens,
  getGlmHeaders,
};

/**
 * Fetch current GLM usage directly from the API on every call.
 *
 * Two fully isolated weekly-quota paths, dispatched by whether quota API
 * returns a `unit:6` (weekly) limit:
 *  - Path A (has unit:6): percentage/tokens/countdown all derive from the
 *    `unit:6` entry and its `[nextResetTime-7d, end]` cycle window.
 *  - Path B (no unit:6): tokens aggregated over the user-timezone natural
 *    week; percentage is null.
 *
 * The paths share no mutable state, no intermediate variables, and do not
 * fall back to each other. Returns null when the platform is not GLM, the
 * base domain/headers are unavailable, or the quota request fails.
 */
export async function getGlmUsage(overrides?: Partial<GlmUsageDeps>): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };

  if (deps.detectPlatform() !== 'glm') return null;

  const baseDomain = deps.getGlmBaseDomain();
  if (!baseDomain) return null;
  const headers = deps.getGlmHeaders();
  if (!headers) return null;

  let quota: QuotaInfo;
  try {
    quota = await deps.fetchQuotaOnly(baseDomain, headers);
  } catch {
    // GlmAuthError / GlmRetryableError / network — all map to "unavailable".
    return null;
  }

  // Dispatch by `unit:6` presence (independent of whether its fields
  // parsed). When unit:6 exists, path A owns the result — it returns null
  // if fields are invalid, and MUST NOT fall back to path B (spec).
  if (quota.hasUnit6) {
    return buildWeeklyFromUnit6(baseDomain, headers, quota, deps).catch(() => null);
  }
  return buildWeeklyFromNaturalWeek(baseDomain, headers, quota, deps).catch(() => null);
}

// ---- Path A: unit:6 cycle window ---------------------------------------

/**
 * Weekly quota derived entirely from the `unit:6` quota entry.
 * Reads no natural-week state. On any internal error returns null.
 */
async function buildWeeklyFromUnit6(
  baseDomain: string,
  headers: Record<string, string>,
  quota: QuotaInfo,
  deps: GlmUsageDeps,
): Promise<UsageData | null> {
  const weeklyPct = quota.weeklyPct;
  const weeklyResetTime = quota.weeklyResetTime;
  // When unit:6 exists but a field is missing/malformed, path A is
  // unavailable. Per spec, MUST NOT fall back to path B — return null.
  if (weeklyPct == null || weeklyResetTime == null) return null;

  const startMs = weeklyResetTime - SEVEN_DAY_MS;
  const endMs = USE_NOW_FOR_PATH_A_END ? Date.now() : weeklyResetTime;
  const sevenDayTokens = await deps.fetchModelUsage(baseDomain, headers, startMs, endMs);

  const fiveHourResetAt = quota.tokensLimitResetTime;
  const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : null;

  return {
    fiveHour: quota.fiveHourPct,
    sevenDay: weeklyPct,
    fiveHourStartAt: fiveHourStartAt != null ? new Date(fiveHourStartAt) : null,
    fiveHourResetAt: fiveHourResetAt != null ? new Date(fiveHourResetAt) : null,
    sevenDayStartAt: new Date(startMs),
    sevenDayResetAt: new Date(weeklyResetTime),
    fiveHourWindowType: 'cycle',
    sevenDayWindowType: 'cycle',
    platform: 'glm',
    sevenDayTokens,
  };
}

// ---- Path B: natural-week window ---------------------------------------

/**
 * Weekly tokens aggregated over the user-timezone natural week. Percentage
 * is null (no quota limit). Reads no `unit:6` state. On any internal error
 * returns null.
 */
async function buildWeeklyFromNaturalWeek(
  baseDomain: string,
  headers: Record<string, string>,
  quota: QuotaInfo,
  deps: GlmUsageDeps,
): Promise<UsageData | null> {
  const { startMs, endMs } = getNaturalWeekRange(resolveTimezone(), Date.now());
  const sevenDayTokens = await deps.fetchModelUsage(baseDomain, headers, startMs, endMs);

  const fiveHourResetAt = quota.tokensLimitResetTime;
  const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : null;

  return {
    fiveHour: quota.fiveHourPct,
    sevenDay: null,
    fiveHourStartAt: fiveHourStartAt != null ? new Date(fiveHourStartAt) : null,
    fiveHourResetAt: fiveHourResetAt != null ? new Date(fiveHourResetAt) : null,
    sevenDayStartAt: new Date(startMs),
    sevenDayResetAt: null,
    fiveHourWindowType: 'cycle',
    sevenDayWindowType: 'rolling',
    platform: 'glm',
    sevenDayTokens,
  };
}
