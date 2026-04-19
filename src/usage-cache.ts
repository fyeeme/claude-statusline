import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getHudPluginDir } from './claude-config-dir.js';
import type { UsagePlatform, UsageWindowType } from './types.js';

export interface CachedUsageData {
  platform: UsagePlatform;
  fiveHour: number | null;
  sevenDay: number | null;
  sevenDayTokens?: number;
  /** 5h window consumed tokens (from model-usage API) */
  fiveHourTokens?: number;
  fiveHourWindowType: UsageWindowType;
  sevenDayWindowType: UsageWindowType;
  /** Timestamp when this entry was cached (ms since epoch) */
  timestamp: number;
  /** TTL in ms — entry is stale after timestamp + ttlMs */
  ttlMs: number;
  /** If true, this entry represents a failure state (e.g. auth error) */
  isError?: boolean;
  /** Timestamp when 5h data was last refreshed (independent of 7d TTL) */
  fiveHourFetchedAt?: number;
  /** Calibrated 7-day token limit (survives cache TTL via readCalibrationFields) */
  calibratedLimit7d?: number;
  /** Timestamp of last successful calibration (ms since epoch) */
  calibratedAt?: number;
  /** fiveHour percentage at time of last calibration (recalibrate when |Δ| ≥ 10) */
  calibratedAtPct?: number;
  /** Inferred subscription time in ms since epoch (survives cache TTL via readCalibrationFields) */
  subscriptionTimeMs?: number;
  /** 5h window start timestamp (ms since epoch) = fiveHourResetAt - 5h */
  fiveHourStartAt?: number | null;
  /** 5h window reset timestamp (ms since epoch) from TOKENS_LIMIT.nextResetTime */
  fiveHourResetAt?: number | null;
  /** 7d cycle start timestamp (ms since epoch) = effectiveCycleStart */
  sevenDayStartAt?: number | null;
  /** 7d cycle end timestamp (ms since epoch) = cycleStart + 7d */
  sevenDayResetAt?: number | null;
  /** Milestone token samples for averaging calibration: { "10": [tokensAt10pct, ...], "20": [...] } */
  milestoneSamples?: Record<string, number[]>;
}

const CACHE_FILENAME = '.usage-cache.json';
const LOG_FILENAME = 'usage.log';
const LOG_MAX_BYTES = 512 * 1024; // 512KB
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ERROR_TTL_BASE_MS = 60 * 1000; // 60 seconds for error states
const RATE_LIMIT_BACKOFF_BASE_MS = 60 * 1000;
const RATE_LIMIT_BACKOFF_CAP_MS = 5 * 60 * 1000;

function getCachePath(): string {
  const homeDir = os.homedir();
  const pluginDir = getHudPluginDir(homeDir);
  return path.join(pluginDir, CACHE_FILENAME);
}

function ensureCacheDir(): string {
  const homeDir = os.homedir();
  const pluginDir = getHudPluginDir(homeDir);
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }
  return pluginDir;
}

/** Read cached usage data. Returns null on cache miss, stale data, or platform mismatch. */
export function readCache(currentPlatform: UsagePlatform): CachedUsageData | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const raw = fs.readFileSync(cachePath, 'utf-8');
    const entry: CachedUsageData = JSON.parse(raw);

    // Platform mismatch → treat as cache miss
    if (entry.platform !== currentPlatform) {
      return null;
    }

    // TTL check
    const now = Date.now();
    if (now > entry.timestamp + entry.ttlMs) {
      return null;
    }

    return entry;
  } catch {
    return null;
  }
}

/** Read calibration and monotonic fields from cache, ignoring TTL.
 *  These fields persist across cache TTL cycles for stable calculations. */
export function readCalibrationFields(): Pick<CachedUsageData, 'calibratedLimit7d' | 'calibratedAt' | 'calibratedAtPct' | 'subscriptionTimeMs' | 'sevenDay' | 'sevenDayTokens' | 'sevenDayStartAt' | 'milestoneSamples'> | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const raw = fs.readFileSync(cachePath, 'utf-8');
    const entry: CachedUsageData = JSON.parse(raw);

    if (entry.calibratedLimit7d != null && entry.calibratedAt != null) {
      return {
        calibratedLimit7d: entry.calibratedLimit7d,
        calibratedAt: entry.calibratedAt,
        calibratedAtPct: entry.calibratedAtPct,
        subscriptionTimeMs: entry.subscriptionTimeMs,
        sevenDay: entry.sevenDay,
        sevenDayTokens: entry.sevenDayTokens,
        sevenDayStartAt: entry.sevenDayStartAt,
        milestoneSamples: entry.milestoneSamples,
      };
    }

    // Also return subscription-only + monotonic data (no calibration yet)
    if (entry.subscriptionTimeMs != null) {
      return {
        subscriptionTimeMs: entry.subscriptionTimeMs,
        calibratedAtPct: entry.calibratedAtPct,
        sevenDay: entry.sevenDay,
        sevenDayTokens: entry.sevenDayTokens,
        sevenDayStartAt: entry.sevenDayStartAt,
        milestoneSamples: entry.milestoneSamples,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/** Merge new cache data with existing cache to protect calibration and monotonic fields
 *  from being lost during concurrent writes from multiple Claude sessions. */
function mergeWithExistingCache(data: Omit<CachedUsageData, 'timestamp'>, cachePath: string): Omit<CachedUsageData, 'timestamp'> {
  let existing: CachedUsageData | null = null;
  try {
    if (fs.existsSync(cachePath)) {
      existing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
  } catch {
    return data;
  }
  if (!existing) return data;

  const merged: Record<string, unknown> = { ...data };

  // Preserve calibration fields: keep existing if new is undefined
  const preserveFields = [
    'calibratedLimit7d', 'calibratedAt', 'calibratedAtPct',
    'subscriptionTimeMs', 'milestoneSamples',
  ] as const;
  for (const field of preserveFields) {
    if (merged[field] === undefined && existing[field] !== undefined) {
      merged[field] = existing[field];
    }
  }

  // Monotonic: within same cycle, sevenDay and sevenDayTokens must not decrease
  if (merged.sevenDayStartAt != null && existing.sevenDayStartAt != null
      && merged.sevenDayStartAt === existing.sevenDayStartAt) {
    if (merged.sevenDay !== null && existing.sevenDay != null
        && typeof merged.sevenDay === 'number' && typeof existing.sevenDay === 'number'
        && merged.sevenDay < existing.sevenDay) {
      merged.sevenDay = existing.sevenDay;
    }
    if (merged.sevenDayTokens != null && existing.sevenDayTokens != null
        && typeof merged.sevenDayTokens === 'number' && typeof existing.sevenDayTokens === 'number'
        && merged.sevenDayTokens < existing.sevenDayTokens) {
      merged.sevenDayTokens = existing.sevenDayTokens;
    }
  }

  return merged as Omit<CachedUsageData, 'timestamp'>;
}

/** Write usage data to cache. Creates the cache directory if needed.
 *  Merges with existing cache to protect calibration data from concurrent writes.
 *  @param preserveTimestamp If set, preserves the original timestamp (used by lightweight 5h refreshes to avoid resetting 7d TTL). */
export function writeCache(data: Omit<CachedUsageData, 'timestamp'>, preserveTimestamp?: number): void {
  const cachePath = getCachePath();
  try {
    ensureCacheDir();

    const merged = mergeWithExistingCache(data, cachePath);
    const entry: CachedUsageData = {
      ...merged,
      timestamp: preserveTimestamp ?? Date.now(),
    };

    // Atomic write: write to temp file, then rename
    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);

    // Ensure correct permissions on the final file
    try {
      fs.chmodSync(cachePath, 0o600);
    } catch {
      // Permissions best-effort
    }
  } catch {
    // Cache write failure is non-blocking
  }
}

/** Append a one-line usage refresh log entry. Rotates at LOG_MAX_BYTES. */
export function appendUsageLog(line: string): void {
  const logPath = path.join(getHudPluginDir(os.homedir()), LOG_FILENAME);
  try {
    // Rotate if oversized
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size > LOG_MAX_BYTES) {
        const raw = fs.readFileSync(logPath, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        const keep = lines.slice(-200);
        fs.writeFileSync(logPath, keep.join('\n') + '\n', { mode: 0o600 });
      }
    }
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(logPath, `[${ts}] ${line}\n`, { mode: 0o600 });
  } catch {
    // Log failure is non-blocking
  }
}
export function getErrorTtlMs(): number {
  const jitter = Math.floor(Math.random() * 30_000); // 0-30s jitter
  return ERROR_TTL_BASE_MS - 15_000 + jitter; // 45-75s
}

/** Get TTL with exponential rate-limit backoff. Base 60s, cap 5min, with jitter. */
export function getRateLimitedTtlMs(retryCount: number = 1): number {
  const baseDelay = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, retryCount - 1);
  const capped = Math.min(baseDelay, RATE_LIMIT_BACKOFF_CAP_MS);
  const jitter = Math.floor(Math.random() * 30_000); // 0-30s jitter
  return capped + jitter;
}

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

/** Infer subscription time from TIME_LIMIT.nextResetTime (monthly reset = subscription anniversary).
 *  Extracts day-of-month and time-of-day from the monthly reset timestamp,
 *  then finds the most recent occurrence of that day+time before now. */
export function inferSubscriptionTime(timeLimitResetMs: number): number {
  const resetDate = new Date(timeLimitResetMs);
  const day = resetDate.getUTCDate();
  const hours = resetDate.getUTCHours();
  const minutes = resetDate.getUTCMinutes();
  const seconds = resetDate.getUTCSeconds();

  // Find the most recent occurrence of this day+time before now
  const nowMs = Date.now();
  const now = new Date(nowMs);

  // Try current month
  let candidateMonth = now.getUTCMonth();
  let candidateYear = now.getUTCFullYear();
  let candidate = Date.UTC(candidateYear, candidateMonth, day, hours, minutes, seconds);
  if (candidate > nowMs) {
    candidateMonth = candidateMonth - 1;
    if (candidateMonth < 0) { candidateMonth = 11; candidateYear--; }
    candidate = Date.UTC(candidateYear, candidateMonth, day, hours, minutes, seconds);
  }

  // Handle month-end edge case: e.g., day=31 in a 30-day month
  // Date.UTC rolls over (Jan 31 → Feb 3), so check if the month matches
  const candidateDate = new Date(candidate);
  if (candidateDate.getUTCMonth() !== candidateMonth) {
    const lastDay = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
    candidate = Date.UTC(candidateYear, candidateMonth, lastDay, hours, minutes, seconds);
  }

  return candidate;
}

/** Compute the current 7-day cycle start from subscription time.
 *  Returns the most recent subscriptionTime + n * 7d that is <= nowMs. */
export function computeCycleStart(subscriptionTimeMs: number, nowMs: number): number {
  const n = Math.floor((nowMs - subscriptionTimeMs) / CYCLE_MS);
  return subscriptionTimeMs + n * CYCLE_MS;
}

/** Convert a CachedUsageData entry back to UsageData-compatible format */
export function cacheToUsageData(cached: CachedUsageData): {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourStartAt: Date | null;
  fiveHourResetAt: Date | null;
  sevenDayStartAt: Date | null;
  sevenDayResetAt: Date | null;
  fiveHourWindowType: UsageWindowType;
  sevenDayWindowType: UsageWindowType;
  platform: UsagePlatform;
  sevenDayTokens?: number;
  calibratedLimit7d?: number;
  calibratedAt?: number;
  subscriptionTimeMs?: number;
} {
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
    calibratedLimit7d: cached.calibratedLimit7d,
    calibratedAt: cached.calibratedAt,
    subscriptionTimeMs: cached.subscriptionTimeMs,
  };
}
