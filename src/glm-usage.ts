import type { UsageData, UsagePlatform, UsageWindowType } from './types.js';
import type { CachedUsageData } from './usage-cache.js';
import { readCache, writeCache, getErrorTtlMs, getRateLimitedTtlMs, cacheToUsageData, readCalibrationFields, inferSubscriptionTime, computeCycleStart } from './usage-cache.js';
import { detectPlatform, getGlmBaseDomain } from './glm-detect.js';
import { DEFAULT_CONFIG } from './config.js';

const FETCH_TIMEOUT_MS = 5000;
const MIN_TOKENS_FOR_7D = 1000;
const RECALIBRATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---- Response types ----

interface QuotaLimit {
  type: string;
  percentage?: number;
  nextResetTime?: number;
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

interface ModelUsageTotalUsage {
  totalModelCallCount?: number;
  totalTokensUsage?: number;
  modelSummaryList?: { modelName: string; totalTokens: number; sortOrder: number }[];
}

interface ModelUsageResponse {
  data?: {
    totalUsage?: ModelUsageTotalUsage;
    modelSummaryList?: { modelName: string; totalTokens: number }[];
    modelDataList?: { modelName: string; totalTokens: number }[];
  } | ModelUsageEntry[];
}

// ---- Helpers ----

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format token count in short notation with floor: >=1B → "1B", >=1M → "347M", >=1K → "850K", else → "999" */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) {
    return `${Math.floor(n / 1_000_000_000)}B`;
  }
  if (n >= 1_000_000) {
    return `${Math.floor(n / 1_000_000)}M`;
  }
  if (n >= 1_000) {
    return `${Math.floor(n / 1_000)}K`;
  }
  return String(n);
}

/** Extract total tokens from model-usage response. Handles both formats:
 *  1. Object format: data.totalUsage.totalTokensUsage (bigmodel.cn)
 *  2. Array format: data[].totalTokens (z.ai / older API)
 */
function extractTotalTokens(data?: ModelUsageResponse['data']): number {
  if (!data) return 0;

  // Object format: data.totalUsage.totalTokensUsage
  if (!Array.isArray(data) && typeof data === 'object') {
    const obj = data as Exclude<ModelUsageResponse['data'], ModelUsageEntry[]>;
    const totalUsage = obj?.totalUsage;
    if (totalUsage && typeof totalUsage.totalTokensUsage === 'number') {
      return totalUsage.totalTokensUsage;
    }
    // Fallback: sum modelSummaryList
    const summary = obj?.modelSummaryList;
    if (Array.isArray(summary)) {
      return summary.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
    }
  }

  // Array format: data[].totalTokens
  if (Array.isArray(data)) {
    return data.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
  }

  return 0;
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
  tokens5h: number;
  tokens7d: number;
  timeLimitResetTime?: number | null;
  /** TOKENS_LIMIT.nextResetTime — 5h window reset timestamp */
  tokensLimitResetTime?: number | null;
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

async function fetchGlmApi(baseDomain: string, headers: Record<string, string>, cycleStart?: number): Promise<GlmApiResults> {
  const now = new Date();
  const start7d = cycleStart != null ? new Date(cycleStart) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Phase 1: quota + 7d usage in parallel (quota needed for 5h window start)
  const [quotaRes, usage7dRes] = await Promise.all([
    fetchWithTimeout(`${baseDomain}/api/monitor/usage/quota/limit`, headers),
    fetchWithTimeout(
      `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(start7d))}&endTime=${encodeURIComponent(formatTimestamp(now))}`,
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
  let timeLimitResetTime: number | null = null;
  let tokensLimitResetTime: number | null = null;
  try {
    const quotaJson: QuotaResponse = await quotaRes.json();
    const limits = quotaJson?.data?.limits;
    if (Array.isArray(limits)) {
      const tokensLimit = limits.find((l) => l.type === 'TOKENS_LIMIT');
      if (tokensLimit && typeof tokensLimit.percentage === 'number' && Number.isFinite(tokensLimit.percentage)) {
        fiveHourPct = clamp(Math.round(tokensLimit.percentage), 0, 100);
      }
      if (tokensLimit && typeof tokensLimit.nextResetTime === 'number' && Number.isFinite(tokensLimit.nextResetTime)) {
        tokensLimitResetTime = tokensLimit.nextResetTime;
      }
      const timeLimit = limits.find((l) => l.type === 'TIME_LIMIT');
      if (timeLimit && typeof timeLimit.nextResetTime === 'number' && Number.isFinite(timeLimit.nextResetTime)) {
        timeLimitResetTime = timeLimit.nextResetTime;
      }
    }
  } catch {
    // Defensive: unexpected response format
    fiveHourPct = null;
  }

  // Phase 2: fetch exact 5h window usage using TOKENS_LIMIT.nextResetTime
  let tokens5h = 0;
  if (tokensLimitResetTime != null) {
    const windowStart = new Date(tokensLimitResetTime - FIVE_HOUR_MS);
    try {
      const usage5hRes = await fetchWithTimeout(
        `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(windowStart))}&endTime=${encodeURIComponent(formatTimestamp(now))}`,
        headers,
      );
      if (usage5hRes.ok) {
        const usageJson: ModelUsageResponse = await usage5hRes.json();
        tokens5h = extractTotalTokens(usageJson?.data);
      }
    } catch {
      // Defensive parsing
    }
  }

  // Parse 7d usage
  let tokens7d = 0;
  try {
    if (usage7dRes.ok) {
      const usageJson: ModelUsageResponse = await usage7dRes.json();
      tokens7d = extractTotalTokens(usageJson?.data);
    }
  } catch {
    // Defensive parsing
  }

  return { fiveHourPct, tokens5h, tokens7d, timeLimitResetTime, tokensLimitResetTime };
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
  fetchGlmApi: (baseDomain: string, headers: Record<string, string>, cycleStart?: number) => Promise<GlmApiResults>;
  getGlmHeaders: () => Record<string, string> | null;
  readCalibrationFields: () => { calibratedLimit7d?: number; calibratedAt?: number; subscriptionTimeMs?: number } | null;
  now: () => number;
  /** Cache TTL in ms for 5h/7d usage data (default: 5 * 60 * 1000) */
  cacheTtlMs: number;
}

const defaultDeps: GlmUsageDeps = {
  detectPlatform: () => detectPlatform(),
  getGlmBaseDomain: () => getGlmBaseDomain(),
  readCache,
  writeCache,
  fetchGlmApi,
  getGlmHeaders,
  readCalibrationFields,
  now: () => Date.now(),
  cacheTtlMs: DEFAULT_CONFIG.usage.fiveHourRefreshSec * 1000,
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
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: 'cycle',
      ttlMs: getErrorTtlMs(),
      isError: true,
    });
    return null;
  }

  // Read calibration state before API call (TTL-exempt, local file read only)
  const calibration = deps.readCalibrationFields();
  const nowMs = deps.now();

  // Compute cycle start from cached subscription time (if available)
  const subscriptionTimeMs = calibration?.subscriptionTimeMs;
  const cycleStart = subscriptionTimeMs != null ? computeCycleStart(subscriptionTimeMs, nowMs) : undefined;

  try {
    const results = await deps.fetchGlmApi(baseDomain, headers, cycleStart);

    const fiveHour = results.fiveHourPct;

    // --- Subscription time inference ---
    let inferredSubscriptionTime: number | undefined;
    if (results.timeLimitResetTime != null && subscriptionTimeMs == null) {
      inferredSubscriptionTime = inferSubscriptionTime(results.timeLimitResetTime);
    }
    const effectiveSubscriptionTime = subscriptionTimeMs ?? inferredSubscriptionTime;

    // --- 7-day percentage calculation ---
    let sevenDay: number | null = null;
    let sevenDayTokens: number | undefined;
    let calibratedLimit7d: number | undefined = calibration?.calibratedLimit7d;
    let calibratedAt: number | undefined = calibration?.calibratedAt;

    const canCalibrate = fiveHour !== null
      && fiveHour > 0
      && results.tokens5h > 0;

    // Determine whether to calibrate/recalibrate
    const needsCalibration = calibratedLimit7d == null
      || (calibratedAt != null && (nowMs - calibratedAt) >= RECALIBRATION_INTERVAL_MS);

    if (needsCalibration && canCalibrate) {
      // Precise calibration: 5h window has exact token usage + percentage
      // 5h_budget = tokens5h × 100 / fiveHour
      // 7d_budget = 5h_budget × 5  (official ratio: 7d limit = 5 × 5h limit)
      calibratedLimit7d = (results.tokens5h * 100 * 5) / fiveHour;
      calibratedAt = nowMs;
    }

    // Compute effective cycle start from subscription time (cached or just-inferred)
    const effectiveCycleStart = effectiveSubscriptionTime != null
      ? computeCycleStart(effectiveSubscriptionTime, nowMs)
      : undefined;

    // Calculate 7d% when subscription time is known (cached or just-inferred)
    if (effectiveCycleStart != null && calibratedLimit7d != null && calibratedLimit7d > 0 && results.tokens7d >= MIN_TOKENS_FOR_7D) {
      const raw7d = (results.tokens7d / calibratedLimit7d) * 100;
      sevenDay = clamp(Math.round(raw7d), 0, 100);
      sevenDayTokens = results.tokens7d;
    }

    if (fiveHour === null && sevenDay === null) {
      return null;
    }

    const fiveHourResetAt = results.tokensLimitResetTime ?? null;
    const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : null;
    const sevenDayStartAt = effectiveCycleStart ?? null;
    const sevenDayResetAt = effectiveCycleStart != null ? effectiveCycleStart + 7 * 24 * 60 * 60 * 1000 : null;

    // Write to cache
    deps.writeCache({
      platform: 'glm',
      fiveHour,
      sevenDay,
      sevenDayTokens,
      fiveHourTokens: results.tokens5h || undefined,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: 'cycle',
      ttlMs: deps.cacheTtlMs,
      calibratedLimit7d,
      calibratedAt,
      subscriptionTimeMs: effectiveSubscriptionTime,
      fiveHourResetAt,
      fiveHourStartAt,
      sevenDayStartAt,
      sevenDayResetAt,
    });

    return {
      fiveHour,
      sevenDay,
      fiveHourStartAt: fiveHourStartAt != null ? new Date(fiveHourStartAt) : null,
      fiveHourResetAt: fiveHourResetAt != null ? new Date(fiveHourResetAt) : null,
      sevenDayStartAt: sevenDayStartAt != null ? new Date(sevenDayStartAt) : null,
      sevenDayResetAt: sevenDayResetAt != null ? new Date(sevenDayResetAt) : null,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: sevenDay !== null ? 'cycle' : undefined,
      platform: 'glm',
      sevenDayTokens,
      fiveHourTokens: results.tokens5h || undefined,
    };
  } catch (err) {
    if ((err as Error)?.name === 'GlmAuthError') {
      deps.writeCache({
        platform: 'glm',
        fiveHour: null,
        sevenDay: null,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        ttlMs: getErrorTtlMs(),
        isError: true,
        calibratedLimit7d: calibration?.calibratedLimit7d,
        calibratedAt: calibration?.calibratedAt,
        subscriptionTimeMs: calibration?.subscriptionTimeMs,
      });
      return null;
    }

    if ((err as Error)?.name === 'GlmRetryableError') {
      // Fall back to stale cached data if available (but not error entries)
      if (cached && !cached.isError) {
        return cacheToUsageData(cached);
      }

      deps.writeCache({
        platform: 'glm',
        fiveHour: null,
        sevenDay: null,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        ttlMs: getRateLimitedTtlMs(1),
        isError: true,
        calibratedLimit7d: calibration?.calibratedLimit7d,
        calibratedAt: calibration?.calibratedAt,
        subscriptionTimeMs: calibration?.subscriptionTimeMs,
      });
      return null;
    }

    // Timeout or unexpected error
    if (cached && !cached.isError) {
      return cacheToUsageData(cached);
    }

    return null;
  }
}
