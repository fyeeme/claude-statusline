import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StdinData, UsageData } from '../../types.js';
import {
  fetchBalance,
  scanWeeklyTokens,
  getDeepSeekApiKey,
  getDeepSeekOrigin,
  type DeepSeekBalance,
} from './api.js';
import { readCache, writeCache, DEEPSEEK_CACHE_TTL_MS, type DeepSeekCacheEntry } from './cache.js';

export interface DeepSeekUsageDeps {
  getApiKey: () => string | null;
  getOrigin: () => string | null;
  readCache: () => DeepSeekCacheEntry | null;
  writeCache: (entry: DeepSeekCacheEntry) => void;
  fetchBalance: (origin: string, apiKey: string) => Promise<DeepSeekBalance | null>;
  scanWeeklyTokens: (projectDir: string, nowMs: number) => number;
  now: () => number;
  cacheTtlMs: number;
}

const defaultDeps: DeepSeekUsageDeps = {
  getApiKey: getDeepSeekApiKey,
  getOrigin: getDeepSeekOrigin,
  readCache: () => readCache(),
  writeCache,
  fetchBalance,
  scanWeeklyTokens,
  now: () => Date.now(),
  cacheTtlMs: DEEPSEEK_CACHE_TTL_MS,
};

/** Compute project sessions dir from cwd: ~/.claude/projects/<cwd-with-dashes> */
export function getProjectSessionsDir(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const projectHash = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', projectHash);
}

/**
 * Fetch DeepSeek usage (balance + natural-week tokens) with a 5-minute cache.
 * Returns null when no API key/origin and no fresh cache. Claude Code sets
 * ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL when using deepseek.
 */
export async function getDeepSeekUsage(
  stdin: StdinData | null,
  overrides?: Partial<DeepSeekUsageDeps>,
): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };
  const nowMs = deps.now();

  const cached = deps.readCache();
  if (cached && nowMs - cached.fetchedAt < deps.cacheTtlMs) {
    return toUsageData(cached);
  }

  // Always scan weekly tokens (fast local file scan, independent of API)
  const projectDir = getProjectSessionsDir(stdin?.cwd);
  const weeklyTokens = projectDir ? deps.scanWeeklyTokens(projectDir, nowMs) : 0;

  // Try balance API
  const apiKey = deps.getApiKey();
  const origin = deps.getOrigin();
  let balance: DeepSeekBalance | null = null;
  if (apiKey && origin) {
    balance = await deps.fetchBalance(origin, apiKey);
  }

  // Return partial data when balance fails but weekly tokens or cache exist
  if (!balance && !cached && weeklyTokens === 0) return null;

  const entry: DeepSeekCacheEntry = {
    balance: balance?.totalBalance ?? cached?.balance ?? '?',
    currency: balance?.currency ?? cached?.currency ?? 'CNY',
    weeklyTokens: weeklyTokens ?? cached?.weeklyTokens ?? 0,
    fetchedAt: nowMs,
    ttlMs: deps.cacheTtlMs,
  };
  deps.writeCache(entry);
  return toUsageData(entry);
}

function toUsageData(entry: DeepSeekCacheEntry): UsageData {
  return {
    fiveHour: null,
    sevenDay: null,
    fiveHourStartAt: null,
    fiveHourResetAt: null,
    sevenDayStartAt: null,
    sevenDayResetAt: null,
    platform: 'deepseek',
    balance: entry.balance,
    currency: entry.currency,
    weeklyTokens: entry.weeklyTokens,
  };
}
