import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_PATH = join(homedir(), '.claude', 'deepseek-usage-cache.json');

export interface DeepSeekCacheEntry {
  balance: string;
  currency: string;
  weeklyTokens: number;
  fetchedAt: number;
  ttlMs: number;
}

/** Read cached DeepSeek usage. Returns null on miss or stale. */
export function readCache(nowMs: number = Date.now()): DeepSeekCacheEntry | null {
  try {
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    const entry = JSON.parse(raw) as DeepSeekCacheEntry;
    if (nowMs - entry.fetchedAt > entry.ttlMs) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Persist DeepSeek usage to cache (best-effort). */
export function writeCache(entry: DeepSeekCacheEntry): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf-8');
  } catch {
    // best-effort
  }
}

export const DEEPSEEK_CACHE_TTL_MS = CACHE_TTL_MS;
