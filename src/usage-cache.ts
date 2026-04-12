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
  fiveHourWindowType: UsageWindowType;
  sevenDayWindowType: UsageWindowType;
  /** Timestamp when this entry was cached (ms since epoch) */
  timestamp: number;
  /** TTL in ms — entry is stale after timestamp + ttlMs */
  ttlMs: number;
  /** If true, this entry represents a failure state (e.g. auth error) */
  isError?: boolean;
}

const CACHE_FILENAME = '.usage-cache.json';
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

/** Write usage data to cache. Creates the cache directory if needed. */
export function writeCache(data: Omit<CachedUsageData, 'timestamp'>): void {
  const cachePath = getCachePath();
  try {
    ensureCacheDir();

    const entry: CachedUsageData = {
      ...data,
      timestamp: Date.now(),
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

/** Get TTL for error states (with jitter: 45-75 seconds) */
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

/** Convert a CachedUsageData entry back to UsageData-compatible format */
export function cacheToUsageData(cached: CachedUsageData): {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  fiveHourWindowType: UsageWindowType;
  sevenDayWindowType: UsageWindowType;
  platform: UsagePlatform;
  sevenDayTokens?: number;
} {
  return {
    fiveHour: cached.fiveHour,
    sevenDay: cached.sevenDay,
    fiveHourResetAt: null, // GLM doesn't provide reset timestamps
    sevenDayResetAt: null,
    fiveHourWindowType: cached.fiveHourWindowType,
    sevenDayWindowType: cached.sevenDayWindowType,
    platform: cached.platform,
    sevenDayTokens: cached.sevenDayTokens,
  };
}
