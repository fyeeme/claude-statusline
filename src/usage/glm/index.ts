import type { UsageData, UsagePlatform, UsageWindowType } from '../../types.js';
import { detectPlatform, getGlmBaseDomain } from '../../glm-detect.js';
import { DEFAULT_CONFIG } from '../../config.js';
import { fetchQuota, fetchFull, getGlmHeaders, formatTimestamp } from './api.js';
import { computeCycleStart } from './calibration.js';
import { readState, writeState, readCache, writeCache, appendLog, getErrorTtlMs, getRateLimitedTtlMs, migrateOldCache } from './cache.js';
import type { CalibrationState, FetchedData, QuotaData, CachedUsage } from './types.js';
import { GlmAuthError, GlmRetryableError } from './types.js';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const MIN_TOKENS_FOR_7D = 1000;

export interface GlmUsageDeps {
  detectPlatform: () => UsagePlatform;
  getGlmBaseDomain: () => string | null;
  readState: () => CalibrationState | null;
  writeState: (state: CalibrationState) => void;
  readCache: (platform: UsagePlatform) => CachedUsage | null;
  writeCache: (data: CachedUsage) => void;
  fetchQuota: (baseDomain: string, headers: Record<string, string>) => Promise<QuotaData>;
  fetchFull: (baseDomain: string, headers: Record<string, string>, cycleStart?: number) => Promise<FetchedData>;
  getGlmHeaders: () => Record<string, string> | null;
  now: () => number;
  cacheTtlMs: number;
  fiveHourTtlMs: number;
  appendLog: (line: string) => void;
  migrateOldCache: () => void;
}

const defaultDeps: GlmUsageDeps = {
  detectPlatform: () => detectPlatform(),
  getGlmBaseDomain: () => getGlmBaseDomain(),
  readState,
  writeState,
  readCache,
  writeCache,
  fetchQuota,
  fetchFull,
  getGlmHeaders,
  now: () => Date.now(),
  cacheTtlMs: DEFAULT_CONFIG.usage.sevenDayRefreshSec * 1000,
  fiveHourTtlMs: DEFAULT_CONFIG.usage.fiveHourRefreshSec * 1000,
  appendLog,
  migrateOldCache,
};

function toUsageData(cached: CachedUsage): UsageData {
  return {
    fiveHour: cached.fiveHour,
    sevenDay: cached.sevenDay,
    fiveHourStartAt: cached.fiveHourStartAt != null ? new Date(cached.fiveHourStartAt) : null,
    fiveHourResetAt: cached.fiveHourResetAt != null ? new Date(cached.fiveHourResetAt) : null,
    sevenDayStartAt: cached.sevenDayStartAt != null ? new Date(cached.sevenDayStartAt) : null,
    sevenDayResetAt: cached.sevenDayResetAt != null ? new Date(cached.sevenDayResetAt) : null,
    fiveHourWindowType: cached.fiveHourWindowType,
    sevenDayWindowType: cached.sevenDayWindowType,
    platform: cached.platform,
    sevenDayTokens: cached.sevenDayTokens,
  };
}

export async function getGlmUsage(overrides?: Partial<GlmUsageDeps>): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };

  if (deps.detectPlatform() !== 'glm') return null;

  // One-time migration from old single-file cache
  deps.migrateOldCache();

  const nowMs = deps.now();
  const cached = deps.readCache('glm');

  // --- Cache hit + 5h fresh → return directly ---
  if (cached && !cached.isError) {
    const fiveHourAge = nowMs - cached.fiveHourFetchedAt;
    if (fiveHourAge < deps.fiveHourTtlMs) {
      if (Math.random() <= 0.1) {
        const ttlRemain = Math.max(0, cached.ttlMs - (nowMs - cached.timestamp));
        deps.appendLog(`cache=HIT 5h=${cached.fiveHour ?? '-'}% 7d=${cached.sevenDay ?? '-'}%(${cached.sevenDayTokens ? Math.floor(cached.sevenDayTokens / 1e6) : '-'}M) ttl=${Math.floor(ttlRemain / 60000)}m`);
      }
      return toUsageData(cached);
    }

    // --- 5h stale, 7d fresh → lightweight refresh ---
    const baseDomain = deps.getGlmBaseDomain();
    if (!baseDomain) return toUsageData(cached);
    const headers = deps.getGlmHeaders();
    if (!headers) return toUsageData(cached);

    try {
      const quota = await deps.fetchQuota(baseDomain, headers);
      const newFiveHour = quota.fiveHourPct;

      // Check for cycle change
      const state = deps.readState();
      const freshCycleStart = state?.subscriptionTimeMs != null
        ? computeCycleStart(state.subscriptionTimeMs, nowMs) : undefined;
      const cycleChanged = freshCycleStart != null && cached.sevenDayStartAt != null
        && freshCycleStart !== cached.sevenDayStartAt;

      // Check for milestone crossing (triggers full refresh for EMA update)
      const milestoneCrossed = newFiveHour != null && cached.fiveHour != null
        && newFiveHour > cached.fiveHour
        && crossesMilestone(cached.fiveHour, newFiveHour);
      const isExactMilestone = newFiveHour != null && newFiveHour > 1 && newFiveHour % 10 === 1;
      const needsFull = cycleChanged || milestoneCrossed || isExactMilestone || newFiveHour === 100;

      if (!needsFull) {
        // Lightweight update: only 5h
        const fiveHourResetAt = quota.tokensLimitResetTime ?? cached.fiveHourResetAt;
        const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : cached.fiveHourStartAt;
        const updated: CachedUsage = {
          ...cached,
          fiveHour: newFiveHour ?? cached.fiveHour,
          fiveHourResetAt,
          fiveHourStartAt,
          fiveHourFetchedAt: nowMs,
        };
        deps.writeCache(updated);
        deps.appendLog(`cache=5h-REFRESH 5h=${newFiveHour ?? '-'}% 7d=${cached.sevenDay ?? '-'}%(${cached.sevenDayTokens ? Math.floor(cached.sevenDayTokens / 1e6) : '-'}M)`);
        return toUsageData(updated);
      }

      deps.appendLog(`cache=5h-${cycleChanged ? 'CYCLE-CHANGED' : 'MILESTONE'} 5h=${newFiveHour ?? '-'}% → full refresh`);
      // Fall through to full refresh
    } catch {
      return toUsageData(cached);
    }
  }

  // --- Full refresh ---
  const baseDomain = deps.getGlmBaseDomain();
  if (!baseDomain) return null;
  const headers = deps.getGlmHeaders();
  if (!headers) {
    deps.writeCache({ platform: 'glm', fiveHour: null, sevenDay: null, sevenDayTokens: undefined,
      fiveHourFetchedAt: nowMs, fiveHourStartAt: null, fiveHourResetAt: null,
      sevenDayStartAt: null, sevenDayResetAt: null, timestamp: nowMs, ttlMs: getErrorTtlMs(),
      isError: true, fiveHourWindowType: 'cycle', sevenDayWindowType: 'cycle' });
    return null;
  }

  deps.appendLog(`cache=MISS`);

  try {
    const fetched = await deps.fetchFull(baseDomain, headers);
    const tokens7d = fetched.tokens7d;

    // 7d% from API weekly percentage (unit:6) — no EMA calibration
    let sevenDay: number | null = fetched.weeklyPct ?? null;
    let sevenDayTokens: number | undefined;
    let sevenDayWindowType: UsageWindowType = 'cycle';
    if (sevenDay != null && tokens7d >= MIN_TOKENS_FOR_7D) {
      sevenDayTokens = tokens7d;
    } else if (sevenDay === null && tokens7d >= MIN_TOKENS_FOR_7D) {
      // 无 unit:6 周限额 → 退化为自然周 token（七Day=null，显示累计 token）
      sevenDayTokens = tokens7d;
      sevenDayWindowType = 'rolling';
    }

    if (fetched.fiveHourPct === null && sevenDay === null && sevenDayTokens === undefined) return null;

    const sevenDayResetAt = fetched.weeklyResetTime ?? null;
    const sevenDayStartAt = sevenDayResetAt != null ? sevenDayResetAt - 7 * 24 * 60 * 60 * 1000 : null;
    const fiveHourResetAt = fetched.tokensLimitResetTime ?? null;
    const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : null;

    deps.writeCache({
      platform: 'glm',
      fiveHour: fetched.fiveHourPct,
      sevenDay,
      sevenDayTokens,
      fiveHourFetchedAt: nowMs,
      fiveHourStartAt,
      fiveHourResetAt,
      sevenDayStartAt,
      sevenDayResetAt,
      timestamp: nowMs,
      ttlMs: deps.cacheTtlMs,
      isError: false,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType,
    });

    const t5hM = Math.floor(fetched.tokens5h / 1e6);
    deps.appendLog(`api 5h=${fetched.fiveHourPct ?? '-'}%(${t5hM}M) 7d=${sevenDay ?? '-'}%(${sevenDayTokens ? Math.floor(sevenDayTokens / 1e6) : '-'}M) reset=${sevenDayResetAt != null ? new Date(sevenDayResetAt).toISOString().slice(5, 16) : '-'}`);

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
  } catch (err) {
    const isAuth = (err as Error)?.name === 'GlmAuthError';
    const isRetryable = (err as Error)?.name === 'GlmRetryableError';

    deps.appendLog(`error=${isAuth ? 'auth' : isRetryable ? 'retryable' : 'unknown'} msg=${(err as Error).message}`);

    if (isAuth) {
      deps.writeCache({ platform: 'glm', fiveHour: null, sevenDay: null, sevenDayTokens: undefined,
        fiveHourFetchedAt: nowMs, fiveHourStartAt: null, fiveHourResetAt: null,
        sevenDayStartAt: null, sevenDayResetAt: null, timestamp: nowMs, ttlMs: getErrorTtlMs(),
        isError: true, fiveHourWindowType: 'cycle', sevenDayWindowType: 'cycle' });
      return null;
    }

    if (cached && !cached.isError) return toUsageData(cached);

    if (isRetryable) {
      deps.writeCache({ platform: 'glm', fiveHour: null, sevenDay: null, sevenDayTokens: undefined,
        fiveHourFetchedAt: nowMs, fiveHourStartAt: null, fiveHourResetAt: null,
        sevenDayStartAt: null, sevenDayResetAt: null, timestamp: nowMs, ttlMs: getRateLimitedTtlMs(1),
        isError: true, fiveHourWindowType: 'cycle', sevenDayWindowType: 'cycle' });
    }
    return null;
  }
}

function crossesMilestone(oldPct: number, newPct: number): boolean {
  for (let m = 10; m <= newPct; m += 10) {
    if (oldPct < m && newPct >= m) return true;
  }
  return false;
}
