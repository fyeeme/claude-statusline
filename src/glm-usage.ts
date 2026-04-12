import type { UsageData, UsagePlatform, UsageWindowType } from './types.js';
import type { CachedUsageData } from './usage-cache.js';
import { readCache, writeCache, getErrorTtlMs, getRateLimitedTtlMs, cacheToUsageData } from './usage-cache.js';
import { detectPlatform, getGlmBaseDomain } from './glm-detect.js';

const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_TOKENS_FOR_7D = 1000;

// ---- Response types ----

interface QuotaLimit {
  type: string;
  percentage?: number;
}

interface QuotaResponse {
  data?: {
    limits?: QuotaLimit[];
  };
}

interface ModelUsageEntry {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

interface ModelUsageResponse {
  data?: ModelUsageEntry[];
}

// ---- Helpers ----

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format token count in short notation: >=1B → "1.2B", >=1M → "310M", >=1K → "850K", else → "999" */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) {
    const val = n / 1_000_000_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}B`;
  }
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}K`;
  }
  return String(n);
}

/** Sum totalTokens from model-usage response entries */
function sumTotalTokens(entries?: ModelUsageEntry[]): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
}

/** Clamp a value to [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- API fetch ----

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getGlmHeaders(): Record<string, string> | null {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!authToken) return null;
  return {
    'Authorization': authToken,
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en',
  };
}

interface GlmApiResults {
  fiveHourPct: number | null;
  tokens24h: number;
  tokens7d: number;
}

async function fetchGlmApi(baseDomain: string, headers: Record<string, string>): Promise<GlmApiResults> {
  const now = new Date();
  const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [quotaRes, usage24hRes, usage7dRes] = await Promise.all([
    fetchWithTimeout(`${baseDomain}/api/monitor/usage/quota/limit`, headers),
    fetchWithTimeout(
      `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(ago24h))}&endTime=${encodeURIComponent(formatTimestamp(now))}`,
      headers,
    ),
    fetchWithTimeout(
      `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(ago7d))}&endTime=${encodeURIComponent(formatTimestamp(now))}`,
      headers,
    ),
  ]);

  // Check for auth errors
  if (quotaRes.status === 401 || quotaRes.status === 403) {
    throw new GlmAuthError(`Auth failed: ${quotaRes.status}`);
  }

  // Check for rate limiting / server errors
  if (quotaRes.status === 429 || quotaRes.status >= 500) {
    throw new GlmRetryableError(`Server/rate-limit error: ${quotaRes.status}`);
  }

  // Parse quota response
  let fiveHourPct: number | null = null;
  try {
    const quotaJson: QuotaResponse = await quotaRes.json();
    const limits = quotaJson?.data?.limits;
    if (Array.isArray(limits)) {
      const tokensLimit = limits.find((l) => l.type === 'TOKENS_LIMIT');
      if (tokensLimit && typeof tokensLimit.percentage === 'number' && Number.isFinite(tokensLimit.percentage)) {
        fiveHourPct = clamp(Math.round(tokensLimit.percentage), 0, 100);
      }
    }
  } catch {
    // Defensive: unexpected response format
    fiveHourPct = null;
  }

  // Parse model-usage responses
  let tokens24h = 0;
  let tokens7d = 0;

  try {
    if (usage24hRes.ok) {
      const usageJson: ModelUsageResponse = await usage24hRes.json();
      tokens24h = sumTotalTokens(usageJson?.data);
    }
  } catch {
    // Defensive parsing
  }

  try {
    if (usage7dRes.ok) {
      const usageJson: ModelUsageResponse = await usage7dRes.json();
      tokens7d = sumTotalTokens(usageJson?.data);
    }
  } catch {
    // Defensive parsing
  }

  return { fiveHourPct, tokens24h, tokens7d };
}

// ---- Error types ----

class GlmAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlmAuthError';
  }
}

class GlmRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlmRetryableError';
  }
}

// ---- Main export ----

export interface GlmUsageDeps {
  detectPlatform: () => UsagePlatform;
  getGlmBaseDomain: () => string | null;
  readCache: (platform: UsagePlatform) => CachedUsageData | null;
  writeCache: (data: Omit<CachedUsageData, 'timestamp'>) => void;
  fetchGlmApi: (baseDomain: string, headers: Record<string, string>) => Promise<GlmApiResults>;
  getGlmHeaders: () => Record<string, string> | null;
}

const defaultDeps: GlmUsageDeps = {
  detectPlatform: () => detectPlatform(),
  getGlmBaseDomain: () => getGlmBaseDomain(),
  readCache,
  writeCache,
  fetchGlmApi,
  getGlmHeaders,
};

/**
 * Get GLM usage data. Returns null if not on GLM platform, auth missing, or all data unavailable.
 * Uses cache-first strategy: returns cached data on cache hit, fetches on miss.
 */
export async function getGlmUsage(overrides?: Partial<GlmUsageDeps>): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };

  const platform = deps.detectPlatform();
  if (platform !== 'glm') {
    return null;
  }

  // Cache-first: check cache
  const cached = deps.readCache('glm');
  if (cached && !cached.isError) {
    return cacheToUsageData(cached);
  }

  // Cache miss or error state: try API
  const baseDomain = deps.getGlmBaseDomain();
  if (!baseDomain) {
    return null;
  }

  const headers = deps.getGlmHeaders();
  if (!headers) {
    // No auth token — cache error state briefly
    deps.writeCache({
      platform: 'glm',
      fiveHour: null,
      sevenDay: null,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'estimated',
      ttlMs: getErrorTtlMs(),
      isError: true,
    });
    return null;
  }

  try {
    const results = await deps.fetchGlmApi(baseDomain, headers);

    const fiveHour = results.fiveHourPct;

    // 7-day percentage calculation with safety guards
    let sevenDay: number | null = null;
    let sevenDayTokens: number | undefined;

    if (results.tokens7d >= MIN_TOKENS_FOR_7D && results.tokens24h > 0) {
      const raw7d = (results.tokens7d * (fiveHour ?? 0)) / (results.tokens24h * 7);
      sevenDay = clamp(Math.round(raw7d), 0, 100);
      sevenDayTokens = results.tokens7d;
    }

    if (fiveHour === null && sevenDay === null) {
      return null;
    }

    // Write to cache
    deps.writeCache({
      platform: 'glm',
      fiveHour,
      sevenDay,
      sevenDayTokens,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'estimated',
      ttlMs: DEFAULT_CACHE_TTL_MS,
    });

    return {
      fiveHour,
      sevenDay,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: sevenDay !== null ? 'estimated' : undefined,
      platform: 'glm',
      sevenDayTokens,
    };
  } catch (err) {
    if ((err as Error)?.name === 'GlmAuthError') {
      deps.writeCache({
        platform: 'glm',
        fiveHour: null,
        sevenDay: null,
        fiveHourWindowType: 'rolling',
        sevenDayWindowType: 'estimated',
        ttlMs: getErrorTtlMs(),
        isError: true,
      });
      return null;
    }

    if ((err as Error)?.name === 'GlmRetryableError') {
      // Fall back to stale cached data if available
      if (cached) {
        return cacheToUsageData(cached);
      }

      deps.writeCache({
        platform: 'glm',
        fiveHour: null,
        sevenDay: null,
        fiveHourWindowType: 'rolling',
        sevenDayWindowType: 'estimated',
        ttlMs: getRateLimitedTtlMs(1),
        isError: true,
      });
      return null;
    }

    // Timeout or unexpected error
    if (cached) {
      return cacheToUsageData(cached);
    }

    return null;
  }
}
