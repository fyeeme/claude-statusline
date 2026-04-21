import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getHudPluginDir } from '../../claude-config-dir.js';
import type { UsagePlatform } from '../../types.js';
import type { CalibrationState, CachedUsage } from './types.js';

const STATE_FILENAME = '.usage-state.json';
const CACHE_FILENAME = '.usage-cache.json';
const LOG_FILENAME = 'usage.log';

const LOG_MAX_BYTES = 512 * 1024; // 512KB
const ERROR_TTL_BASE_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_BACKOFF_BASE_MS = 60 * 1000;
const RATE_LIMIT_BACKOFF_CAP_MS = 5 * 60 * 1000;

/** Format timestamp to human-readable string in UTC+8 (Shanghai timezone): "2025-04-20 22:30:45 CST" */
function formatTimestampForCache(ms: number): string {
  const date = new Date(ms);
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = utc8.getUTCFullYear();
  const mm = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc8.getUTCDate()).padStart(2, '0');
  const hh = String(utc8.getUTCHours()).padStart(2, '0');
  const min = String(utc8.getUTCMinutes()).padStart(2, '0');
  const ss = String(utc8.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} CST`;
}

/** Ensure and return plugin directory. */
function getCacheDir(): string {
  const pluginDir = getHudPluginDir(os.homedir());
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }
  return pluginDir;
}

/** Path to .usage-cache.json */
function getCachePath(): string {
  return path.join(getCacheDir(), CACHE_FILENAME);
}

/** Path to .usage-state.json */
function getStatePath(): string {
  return path.join(getCacheDir(), STATE_FILENAME);
}

// --- State file (persistent calibration, no TTL) ---

/** Read .usage-state.json. Returns null on missing/invalid file. No TTL check. */
export function readState(): CalibrationState | null {
  const statePath = getStatePath();
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!fs.existsSync(statePath)) return null;
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw) as CalibrationState;
    } catch (err) {
      // Retry once on parse error (concurrent write race)
      if (attempt < maxRetries && (err as SyntaxError)?.name === 'SyntaxError') {
        const start = Date.now();
        while (Date.now() - start < 5) { /* busy wait 5ms */ }
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Atomic write to .usage-state.json. */
export function writeState(state: CalibrationState): void {
  const statePath = getStatePath();
  try {
    getCacheDir();

    const tmpPath = statePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, statePath);

    try { fs.chmodSync(statePath, 0o600); } catch { /* best-effort */ }
  } catch {
    // State write failure is non-blocking
  }
}

// --- Cache file (transient usage data, TTL-controlled) ---

/** Read .usage-cache.json. Returns null on miss, stale, or platform mismatch. */
export function readCache(platform: UsagePlatform): CachedUsage | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;

    const raw = fs.readFileSync(cachePath, 'utf-8');
    const entry: CachedUsage = JSON.parse(raw);

    if (entry.platform !== platform) return null;

    // TTL check
    const now = Date.now();
    if (now > entry.timestamp + entry.ttlMs) return null;

    return entry;
  } catch {
    return null;
  }
}

/** Atomic write to .usage-cache.json. No deep merge needed. */
export function writeCache(data: CachedUsage): void {
  const cachePath = getCachePath();
  try {
    getCacheDir();

    const entry = {
      ...data,
      formattedTimestamps: {
        timestamp: formatTimestampForCache(data.timestamp),
        fiveHourFetchedAt: data.fiveHourFetchedAt != null ? formatTimestampForCache(data.fiveHourFetchedAt) : undefined,
        fiveHourStartAt: data.fiveHourStartAt != null ? formatTimestampForCache(data.fiveHourStartAt) : undefined,
        fiveHourResetAt: data.fiveHourResetAt != null ? formatTimestampForCache(data.fiveHourResetAt) : undefined,
        sevenDayStartAt: data.sevenDayStartAt != null ? formatTimestampForCache(data.sevenDayStartAt) : undefined,
        sevenDayResetAt: data.sevenDayResetAt != null ? formatTimestampForCache(data.sevenDayResetAt) : undefined,
      },
    };

    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);

    try { fs.chmodSync(cachePath, 0o600); } catch { /* best-effort */ }
  } catch {
    // Cache write failure is non-blocking
  }
}

// --- Log rotation ---

/** Append a one-line usage log entry. Rotates at LOG_MAX_BYTES. */
export function appendLog(line: string): void {
  const logPath = path.join(getHudPluginDir(os.homedir()), LOG_FILENAME);
  try {
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

// --- TTL helpers ---

/** Error TTL: 45-75s with jitter. */
export function getErrorTtlMs(): number {
  const jitter = Math.floor(Math.random() * 30_000); // 0-30s jitter
  return ERROR_TTL_BASE_MS - 15_000 + jitter; // 45-75s
}

/** Rate-limited TTL: exponential backoff, cap 5min, with jitter. */
export function getRateLimitedTtlMs(retryCount: number = 1): number {
  const baseDelay = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, retryCount - 1);
  const capped = Math.min(baseDelay, RATE_LIMIT_BACKOFF_CAP_MS);
  const jitter = Math.floor(Math.random() * 30_000);
  return capped + jitter;
}

// --- Migration ---

/** One-time migration: extract calibration fields from old single-file cache into state file. */
export function migrateOldCache(): void {
  const statePath = getStatePath();
  // Skip if state file already exists
  if (fs.existsSync(statePath)) return;

  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return;

    const raw = fs.readFileSync(cachePath, 'utf-8');
    const old = JSON.parse(raw) as Record<string, unknown>;

    // Check for calibration fields in old format
    if (old.calibratedLimit7d != null || old.calibratedAt != null || old.subscriptionTimeMs != null) {
      const state: CalibrationState = {
        calibratedLimit7d: (old.calibratedLimit7d as number | null) ?? null,
        calibratedAt: (old.calibratedAt as number) ?? 0,
        subscriptionTimeMs: (old.subscriptionTimeMs as number | null) ?? null,
      };
      writeState(state);
    }
  } catch {
    // Migration failure is non-blocking
  }
}
