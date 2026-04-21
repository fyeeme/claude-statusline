import type { UsageData, UsagePlatform } from '../../types.js';
import { detectPlatform, getGlmBaseDomain } from '../../glm-detect.js';
import { DEFAULT_CONFIG } from '../../config.js';
import { fetchQuota, fetchFull, getGlmHeaders, formatTimestamp, fetchWithTimeout } from './api.js';
import { extractTotalTokens } from './api.js';
import { updateCalibration, inferSubscriptionTime, computeCycleStart } from './calibration.js';
import { compute7d, applyMonotonicGuard } from './compute.js';
import { readState, writeState, readCache, writeCache, appendLog, getErrorTtlMs, getRateLimitedTtlMs, migrateOldCache } from './cache.js';
import type { CalibrationState, FetchedData, QuotaData, CachedUsage } from './types.js';
import { GlmAuthError, GlmRetryableError } from './types.js';
import type { ModelUsageResponse } from './api.js';

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

  const state = deps.readState();
  const cycleStart = state?.subscriptionTimeMs != null
    ? computeCycleStart(state.subscriptionTimeMs, nowMs) : undefined;

  deps.appendLog(`cache=MISS cycle=${cycleStart != null ? new Date(cycleStart).toISOString().slice(5, 16) : 'null'} subMs=${state?.subscriptionTimeMs ?? '-'}`);

  try {
    let fetched = await deps.fetchFull(baseDomain, headers, cycleStart);

    // Subscription time inference
    let subTime = state?.subscriptionTimeMs;
    if (subTime == null && fetched.timeLimitResetTime != null) {
      subTime = inferSubscriptionTime(fetched.timeLimitResetTime);
    }
    const effectiveCycleStart = subTime != null ? computeCycleStart(subTime, nowMs) : undefined;

    // Re-query 7d if calibration was lost (cycleStart was null) and correct start differs from now-7d
    let tokens7d = fetched.tokens7d;
    if (cycleStart == null && effectiveCycleStart != null) {
      const cycleAgeDays = (nowMs - effectiveCycleStart) / (24 * 60 * 60 * 1000);
      if (cycleAgeDays < 6 && tokens7d > 0) {
        const start7d = new Date(effectiveCycleStart);
        const end = new Date(nowMs);
        const url = `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(start7d))}&endTime=${encodeURIComponent(formatTimestamp(end))}`;
        try {
          const res = await fetchWithTimeout(url, headers);
          if (res.ok) {
            const json: ModelUsageResponse = await res.json();
            const reQueryTokens = extractTotalTokens(json?.data);
            if (reQueryTokens >= 0) {
              deps.appendLog(`requery old=${Math.floor(tokens7d / 1e6)}M new=${Math.floor(reQueryTokens / 1e6)}M`);
              tokens7d = reQueryTokens;
              fetched = { ...fetched, tokens7d };
            }
          }
        } catch { /* keep original tokens7d */ }
      }
    }

    // Calibrate (EMA)
    const calibrated = updateCalibration(fetched.tokens5h, fetched.fiveHourPct ?? 0, state, nowMs, deps.appendLog);
    // Preserve subscription time in state
    const newState: CalibrationState = {
      calibratedLimit7d: calibrated.calibratedLimit7d,
      calibratedAt: calibrated.calibratedAt,
      subscriptionTimeMs: subTime ?? calibrated.subscriptionTimeMs ?? null,
    };

    // Compute 7d%
    let sevenDay: number | null = null;
    let sevenDayTokens: number | undefined;
    // Only use EMA-calibrated limit. When null, 7d% is not displayed —
    // avoids wildly unstable single-point estimates at low 5h%.
    const effectiveLimit = newState.calibratedLimit7d;

    if (effectiveCycleStart != null && effectiveLimit != null && effectiveLimit > 0 && tokens7d >= MIN_TOKENS_FOR_7D) {
      sevenDay = compute7d(tokens7d, effectiveLimit);
      sevenDayTokens = tokens7d;
    }

    if (fetched.fiveHourPct === null && sevenDay === null) return null;

    // Monotonic guard
    const sameCycle = cached?.sevenDayStartAt != null && effectiveCycleStart != null
      && cached.sevenDayStartAt === effectiveCycleStart;
    const guarded = applyMonotonicGuard(
      sevenDay, sevenDayTokens,
      cached?.sevenDay ?? null, cached?.sevenDayTokens,
      sameCycle,
    );

    const sevenDayStartAt = effectiveCycleStart ?? null;
    const sevenDayResetAt = effectiveCycleStart != null ? effectiveCycleStart + 7 * 24 * 60 * 60 * 1000 : null;
    const fiveHourResetAt = fetched.tokensLimitResetTime ?? null;
    const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : null;

    // Persist
    deps.writeState(newState);
    deps.writeCache({
      platform: 'glm',
      fiveHour: fetched.fiveHourPct,
      sevenDay: guarded.sevenDay,
      sevenDayTokens: guarded.sevenDayTokens,
      fiveHourFetchedAt: nowMs,
      fiveHourStartAt,
      fiveHourResetAt,
      sevenDayStartAt,
      sevenDayResetAt,
      timestamp: nowMs,
      ttlMs: deps.cacheTtlMs,
      isError: false,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: 'cycle',
    });

    const limitM = newState.calibratedLimit7d ? Math.floor(newState.calibratedLimit7d / 1e6) : 0;
    const prevLimit = state?.calibratedLimit7d;
    const newLimit = newState.calibratedLimit7d;
    const t5hM = Math.floor(fetched.tokens5h / 1e6);
    const pct = fetched.fiveHourPct ?? 0;
    let calibTag: string;
    if (newLimit != null) {
      if (prevLimit == null) {
        calibTag = `single:${t5hM}M*500/${pct}`;
      } else if (newLimit !== prevLimit) {
        calibTag = `ema:${t5hM}M*500/${pct}→${limitM}M`;
      } else {
        calibTag = 'preserved';
      }
    } else if (effectiveLimit != null) {
      calibTag = 'limit-only';
    } else {
      calibTag = 'none';
    }
    const t5h = fetched.tokens5h;
    const t7d = tokens7d;
    deps.appendLog(`api 5h=${fetched.fiveHourPct ?? '-'}%(${t5h != null ? Math.floor(t5h / 1e6) : '-'}M) 7d=${guarded.sevenDay ?? '-'}%(${guarded.sevenDayTokens ? Math.floor(guarded.sevenDayTokens / 1e6) : '-'}M/${t7d != null ? Math.floor(t7d / 1e6) : '-'}M) limit=${limitM}M(${calibTag}) cycle=${sevenDayStartAt != null ? new Date(sevenDayStartAt).toISOString().slice(5, 16) : '-'}`);

    return {
      fiveHour: fetched.fiveHourPct,
      sevenDay: guarded.sevenDay,
      fiveHourStartAt: fiveHourStartAt != null ? new Date(fiveHourStartAt) : null,
      fiveHourResetAt: fiveHourResetAt != null ? new Date(fiveHourResetAt) : null,
      sevenDayStartAt: sevenDayStartAt != null ? new Date(sevenDayStartAt) : null,
      sevenDayResetAt: sevenDayResetAt != null ? new Date(sevenDayResetAt) : null,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: guarded.sevenDay !== null ? 'cycle' : undefined,
      platform: 'glm',
      sevenDayTokens: guarded.sevenDayTokens,
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
