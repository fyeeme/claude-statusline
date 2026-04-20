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
  /** Human-readable formatted timestamps (for easier JSON inspection) */
  formattedTimestamps?: {
    timestamp?: string;
    fiveHourFetchedAt?: string;
    calibratedAt?: string;
    subscriptionTime?: string;
    fiveHourStartAt?: string;
    fiveHourResetAt?: string;
    sevenDayStartAt?: string;
    sevenDayResetAt?: string;
  };
}

const CACHE_FILENAME = '.usage-cache.json';
const LOG_FILENAME = 'usage.log';

/** Format timestamp to human-readable string in UTC+8 (Shanghai timezone): "2025-04-20 22:30:45 CST" */
function formatTimestampForCache(ms: number): string {
  const date = new Date(ms);
  // Convert to UTC+8 by adding 8 hours and formatting
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = utc8.getUTCFullYear();
  const mm = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc8.getUTCDate()).padStart(2, '0');
  const hh = String(utc8.getUTCHours()).padStart(2, '0');
  const min = String(utc8.getUTCMinutes()).padStart(2, '0');
  const ss = String(utc8.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} CST`;
}
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
  const maxRetries = 2;
  const retryDelay = 5; // 5ms between retries

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!fs.existsSync(cachePath)) {
        return null;
      }

      const raw = fs.readFileSync(cachePath, 'utf-8');
      const entry: CachedUsageData = JSON.parse(raw);

      // Return all available fields if any calibration or subscription data exists
      if (entry.calibratedLimit7d != null || entry.calibratedAt != null || entry.subscriptionTimeMs != null) {
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

      return null;
    } catch (err) {
      // On parse error, retry briefly (might be concurrent write in progress)
      if (attempt < maxRetries && (err as SyntaxError)?.name === 'SyntaxError') {
        const start = Date.now();
        while (Date.now() - start < retryDelay) {
          // Busy wait for retryDelay ms
        }
        continue;
      }
      // Other errors or final attempt: give up
      return null;
    }
  }

  return null;
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
    'subscriptionTimeMs',
  ] as const;

  // Preserve formattedTimestamps if new data doesn't have it
  if (merged.formattedTimestamps === undefined && existing.formattedTimestamps !== undefined) {
    merged.formattedTimestamps = existing.formattedTimestamps;
  }
  for (const field of preserveFields) {
    if (merged[field] === undefined && existing[field] !== undefined) {
      merged[field] = existing[field];
    }
  }

  // milestoneSamples: deep merge per-key arrays + dedup (handles concurrent writes)
  const newMs = merged.milestoneSamples as Record<string, number[]> | undefined;
  const oldMs = existing.milestoneSamples as Record<string, number[]> | undefined;
  if (newMs && oldMs) {
    const combined: Record<string, number[]> = {};
    const allKeys = new Set([...Object.keys(newMs), ...Object.keys(oldMs)]);
    for (const key of allKeys) {
      const mergedArr = [...(oldMs[key] ?? []), ...(newMs[key] ?? [])];
      combined[key] = [...new Set(mergedArr)];
    }
    merged.milestoneSamples = combined;
  } else if (oldMs && !newMs) {
    merged.milestoneSamples = oldMs;
  }

  // Cycle boundary: preserve the newer cycle's 7d data.
  // When two concurrent sessions have different cycle starts, the side with the
  // larger sevenDayStartAt is the newer (more recent) cycle.  The older cycle's
  // sevenDay values are stale and must not overwrite the newer ones.
  const cycleChanged = (
    merged.sevenDayStartAt != null &&
    existing.sevenDayStartAt != null &&
    merged.sevenDayStartAt !== existing.sevenDayStartAt
  );
  if (cycleChanged) {
    const mergedIsNewer = ((merged.sevenDayStartAt as number | null | undefined) ?? 0) > ((existing.sevenDayStartAt as number | null | undefined) ?? 0);
    if (!mergedIsNewer) {
      // Existing cache has the newer cycle → preserve its 7d data
      merged.sevenDay = existing.sevenDay;
      merged.sevenDayTokens = existing.sevenDayTokens;
      merged.sevenDayStartAt = existing.sevenDayStartAt;
      merged.sevenDayResetAt = existing.sevenDayResetAt;
    }
    // If merged is newer, its computed values are already correct for the new cycle
  }

  // Monotonic: within same cycle, sevenDay and sevenDayTokens must not decrease
  // EXCEPTION: if tokens dropped >50%, the cached value was likely from a wrong API query
  // (e.g. now-7d fallback due to calibration loss), so allow the drop.
  if (!cycleChanged &&
      merged.sevenDayStartAt != null && existing.sevenDayStartAt != null
      && merged.sevenDayStartAt === existing.sevenDayStartAt) {
    const tokenDropIsMassive = merged.sevenDayTokens != null && existing.sevenDayTokens != null
      && typeof merged.sevenDayTokens === 'number' && typeof existing.sevenDayTokens === 'number'
      && merged.sevenDayTokens < existing.sevenDayTokens * 0.5;
    if (merged.sevenDay !== null && existing.sevenDay != null
        && typeof merged.sevenDay === 'number' && typeof existing.sevenDay === 'number'
        && merged.sevenDay < existing.sevenDay) {
      merged.sevenDay = existing.sevenDay;
    }
    if (!tokenDropIsMassive && merged.sevenDayTokens != null && existing.sevenDayTokens != null
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
    const timestamp = preserveTimestamp ?? Date.now();

    // Generate human-readable formatted timestamps (only include non-null values)
    const formattedTimestamps: NonNullable<CachedUsageData['formattedTimestamps']> = {};
    formattedTimestamps.timestamp = formatTimestampForCache(timestamp);
    if (merged.fiveHourFetchedAt != null) formattedTimestamps.fiveHourFetchedAt = formatTimestampForCache(merged.fiveHourFetchedAt);
    if (merged.calibratedAt != null) formattedTimestamps.calibratedAt = formatTimestampForCache(merged.calibratedAt);
    if (merged.subscriptionTimeMs != null) formattedTimestamps.subscriptionTime = formatTimestampForCache(merged.subscriptionTimeMs);
    if (merged.fiveHourStartAt != null) formattedTimestamps.fiveHourStartAt = formatTimestampForCache(merged.fiveHourStartAt);
    if (merged.fiveHourResetAt != null) formattedTimestamps.fiveHourResetAt = formatTimestampForCache(merged.fiveHourResetAt);
    if (merged.sevenDayStartAt != null) formattedTimestamps.sevenDayStartAt = formatTimestampForCache(merged.sevenDayStartAt);
    if (merged.sevenDayResetAt != null) formattedTimestamps.sevenDayResetAt = formatTimestampForCache(merged.sevenDayResetAt);

    const entry: CachedUsageData = {
      ...merged,
      timestamp,
      formattedTimestamps,
    };

    // Atomic write: write to temp file, then rename
    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), { mode: 0o600 });
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
