import type { UsageData, UsagePlatform, UsageWindowType } from './types.js';
import type { CachedUsageData } from './usage-cache.js';
import { readCache, writeCache, getErrorTtlMs, getRateLimitedTtlMs, cacheToUsageData, readCalibrationFields, inferSubscriptionTime, computeCycleStart, appendUsageLog } from './usage-cache.js';
import { detectPlatform, getGlmBaseDomain } from './glm-detect.js';
import { DEFAULT_CONFIG } from './config.js';

const FETCH_TIMEOUT_MS = 5000;
const MIN_TOKENS_FOR_7D = 1000;

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

/** Results from quota-only fetch (lightweight 5h refresh) */
interface GlmQuotaResults {
  fiveHourPct: number | null;
  tokensLimitResetTime?: number | null;
  timeLimitResetTime?: number | null;
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** Lightweight fetch: quota endpoint only (1 HTTP request). Used for 5h-only refreshes. */
async function fetchGlmQuotaOnly(baseDomain: string, headers: Record<string, string>, appendLog?: (line: string) => void): Promise<GlmQuotaResults> {
  const log = appendLog ?? (() => {});
  const quotaUrl = `${baseDomain}/api/monitor/usage/quota/limit`;

  const quotaRes = await fetchWithTimeout(quotaUrl, headers);

  let quotaRaw = '';
  try { quotaRaw = await quotaRes.clone().text(); } catch { /* */ }
  log(`req GET ${quotaUrl.replace(baseDomain, '')} → ${quotaRes.status} body=${quotaRaw.slice(0, 500)}`);

  if (quotaRes.status === 401 || quotaRes.status === 403) {
    throw new GlmAuthError(`Auth failed: ${quotaRes.status}`);
  }
  if (quotaRes.status === 429 || quotaRes.status >= 500) {
    throw new GlmRetryableError(`Server/rate-limit error: ${quotaRes.status}`);
  }

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
    fiveHourPct = null;
  }

  return { fiveHourPct, tokensLimitResetTime, timeLimitResetTime };
}

async function fetchGlmApi(baseDomain: string, headers: Record<string, string>, cycleStart?: number, appendLog?: (line: string) => void): Promise<GlmApiResults> {
  const now = new Date();
  const start7d = cycleStart != null ? new Date(cycleStart) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const log = appendLog ?? (() => {});

  // Phase 1: quota + 7d usage in parallel (quota needed for 5h window start)
  const quotaUrl = `${baseDomain}/api/monitor/usage/quota/limit`;
  const usage7dUrl = `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(start7d))}&endTime=${encodeURIComponent(formatTimestamp(now))}`;

  const [quotaRes, usage7dRes] = await Promise.all([
    fetchWithTimeout(quotaUrl, headers),
    fetchWithTimeout(usage7dUrl, headers),
  ]);

  // Log quota request/response
  let quotaRaw = '';
  try { quotaRaw = await quotaRes.clone().text(); } catch { /* */ }
  log(`req GET ${quotaUrl.replace(baseDomain, '')} → ${quotaRes.status} body=${quotaRaw.slice(0, 500)}`);
  log(`req GET ${usage7dUrl.replace(baseDomain, '').slice(0, 120)} → ${usage7dRes.status}`);

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
    const usage5hUrl = `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(windowStart))}&endTime=${encodeURIComponent(formatTimestamp(now))}`;
    try {
      const usage5hRes = await fetchWithTimeout(usage5hUrl, headers);
      let usage5hRaw = '';
      try { usage5hRaw = await usage5hRes.clone().text(); } catch { /* */ }
      log(`req GET ${usage5hUrl.replace(baseDomain, '')} → ${usage5hRes.status} body=${usage5hRaw.slice(0, 300)}`);
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
  writeCache: (data: Omit<CachedUsageData, 'timestamp'>, preserveTimestamp?: number) => void;
  fetchGlmApi: (baseDomain: string, headers: Record<string, string>, cycleStart?: number, appendLog?: (line: string) => void) => Promise<GlmApiResults>;
  fetchGlmQuotaOnly: (baseDomain: string, headers: Record<string, string>, appendLog?: (line: string) => void) => Promise<GlmQuotaResults>;
  getGlmHeaders: () => Record<string, string> | null;
  readCalibrationFields: () => { calibratedLimit7d?: number; calibratedAt?: number; calibratedAtPct?: number; subscriptionTimeMs?: number; sevenDay?: number | null; sevenDayTokens?: number; sevenDayStartAt?: number | null; milestoneSamples?: Record<string, number[]> } | null;
  now: () => number;
  /** Cache TTL in ms for 7d usage data (default: fiveHourRefreshSec * 1000) */
  cacheTtlMs: number;
  /** Cache TTL in ms for 5h data (default: fiveHourRefreshSec * 1000) */
  fiveHourTtlMs: number;
  /** Log function for usage refresh events (default: appendUsageLog) */
  appendLog: (line: string) => void;
}

const defaultDeps: GlmUsageDeps = {
  detectPlatform: () => detectPlatform(),
  getGlmBaseDomain: () => getGlmBaseDomain(),
  readCache,
  writeCache,
  fetchGlmApi,
  fetchGlmQuotaOnly,
  getGlmHeaders,
  readCalibrationFields,
  now: () => Date.now(),
  cacheTtlMs: DEFAULT_CONFIG.usage.sevenDayRefreshSec * 1000,
  fiveHourTtlMs: DEFAULT_CONFIG.usage.fiveHourRefreshSec * 1000,
  appendLog: appendUsageLog,
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
    const nowMs = deps.now();
    const fiveHourAge = nowMs - (cached.fiveHourFetchedAt ?? cached.timestamp);

    if (fiveHourAge < deps.fiveHourTtlMs) {
      // Both 5h and 7d fresh → return cache
      const r = Math.floor(Math.random() * 100);
      if (r <= 5 || r >= 95) {
        const ttlRemain = Math.max(0, cached.ttlMs - (nowMs - cached.timestamp));
        const ttlM = Math.floor(ttlRemain / 60000);
        const ttlS = Math.floor((ttlRemain % 60000) / 1000);
        deps.appendLog(
          `cache=HIT 5h=${cached.fiveHour ?? '-'}% 7d=${cached.sevenDay ?? '-'}%(${cached.sevenDayTokens ? Math.floor(cached.sevenDayTokens / 1e6) : '-'}M) ttl=${ttlM}m${ttlS}s`,
        );
      }
      return cacheToUsageData(cached);
    }

    // 5h stale, 7d fresh → try lightweight refresh
    const baseDomain = deps.getGlmBaseDomain();
    if (!baseDomain) return cacheToUsageData(cached);

    const headers = deps.getGlmHeaders();
    if (!headers) return cacheToUsageData(cached);

    try {
      const quotaResult = await deps.fetchGlmQuotaOnly(baseDomain, headers, deps.appendLog);
      const newFiveHour = quotaResult.fiveHourPct;

      // Milestone detected → upgrade to full refresh (sample at pct+1: 11%, 21%... or 100%)
      const isMilestone = (newFiveHour != null && newFiveHour > 1 && newFiveHour % 10 === 1)
        || newFiveHour === 100;
      if (isMilestone) {
        deps.appendLog(`cache=5h-MILESTONE 5h=${newFiveHour}% → full refresh`);
        // Fall through to full refresh below
      } else {
        // Lightweight update: only 5h fields, preserve 7d TTL
        const fiveHourResetAt = quotaResult.tokensLimitResetTime ?? cached.fiveHourResetAt ?? null;
        const fiveHourStartAt = fiveHourResetAt != null ? fiveHourResetAt - FIVE_HOUR_MS : cached.fiveHourStartAt ?? null;

        deps.writeCache({
          platform: 'glm',
          fiveHour: newFiveHour ?? cached.fiveHour,
          sevenDay: cached.sevenDay,
          sevenDayTokens: cached.sevenDayTokens,
          fiveHourWindowType: 'cycle',
          sevenDayWindowType: cached.sevenDayWindowType,
          ttlMs: cached.ttlMs,
          calibratedLimit7d: cached.calibratedLimit7d,
          calibratedAt: cached.calibratedAt,
          calibratedAtPct: cached.calibratedAtPct,
          subscriptionTimeMs: cached.subscriptionTimeMs,
          fiveHourResetAt,
          fiveHourStartAt,
          fiveHourFetchedAt: nowMs,
          sevenDayStartAt: cached.sevenDayStartAt,
          sevenDayResetAt: cached.sevenDayResetAt,
          milestoneSamples: cached.milestoneSamples,
        }, cached.timestamp);

        deps.appendLog(`cache=5h-REFRESH 5h=${newFiveHour ?? '-'}% 7d=${cached.sevenDay ?? '-'}%(${cached.sevenDayTokens ? Math.floor(cached.sevenDayTokens / 1e6) : '-'}M)`);

        return {
          fiveHour: newFiveHour ?? cached.fiveHour,
          sevenDay: cached.sevenDay,
          fiveHourStartAt: fiveHourStartAt != null ? new Date(fiveHourStartAt) : null,
          fiveHourResetAt: fiveHourResetAt != null ? new Date(fiveHourResetAt) : null,
          sevenDayStartAt: cached.sevenDayStartAt != null ? new Date(cached.sevenDayStartAt) : null,
          sevenDayResetAt: cached.sevenDayResetAt != null ? new Date(cached.sevenDayResetAt) : null,
          fiveHourWindowType: 'cycle',
          sevenDayWindowType: cached.sevenDayWindowType,
          platform: 'glm',
          sevenDayTokens: cached.sevenDayTokens,
        };
      }
    } catch {
      // Lightweight refresh failed → return stale cached data
      return cacheToUsageData(cached);
    }
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
    const results = await deps.fetchGlmApi(baseDomain, headers, cycleStart, deps.appendLog);

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
    let calibratedAtPct: number | undefined = calibration?.calibratedAtPct;

    // --- Milestone samples for averaging calibration ---
    const MAX_SAMPLES_PER_MILESTONE = 10;
    let milestoneSamples: Record<string, number[]> | undefined = calibration?.milestoneSamples
      ? { ...calibration.milestoneSamples }
      : undefined;

    // Clear samples on new cycle
    const prevCycleStartForSamples = calibration?.sevenDayStartAt;
    const effectiveCycleStartForSamples = effectiveSubscriptionTime != null
      ? computeCycleStart(effectiveSubscriptionTime, nowMs)
      : undefined;
    if (effectiveCycleStartForSamples != null
      && prevCycleStartForSamples != null
      && effectiveCycleStartForSamples !== prevCycleStartForSamples) {
      milestoneSamples = undefined;
    }

    const canCalibrate = fiveHour !== null
      && fiveHour > 0
      && results.tokens5h > 0;

    // Collect sample at milestone+1 (11%, 21%, 31%...) and attribute to milestone (10%, 20%, 30%).
    // At pct+1, tokens5h has fully settled to reflect ~pct worth of tokens,
    // avoiding the "just crossed threshold" low-bias from sampling at exact milestone.
    // 100% triggers calibration directly: tokens5h × 5 (tokens5h ≈ full 5h budget).
    const isMilestone = (fiveHour != null && fiveHour > 1 && fiveHour % 10 === 1)
      || fiveHour === 100;
    if (fiveHour === 100 && canCalibrate) {
      // 100%: direct calculation, no milestone sampling
      const hundredPctLimit = results.tokens5h * 5;
      if (calibratedLimit7d != null && hundredPctLimit < calibratedLimit7d) {
        deps.appendLog(
          `warning=CALIBRATION_REGRESSION old=${Math.floor(calibratedLimit7d / 1e6)}M new=${Math.floor(hundredPctLimit / 1e6)}M at 100%`,
        );
        // Keep old value
      } else {
        calibratedLimit7d = hundredPctLimit;
        calibratedAt = nowMs;
        calibratedAtPct = 100;
      }
    } else if (isMilestone && canCalibrate) {
      const milestoneKey = String(fiveHour! - 1);
      if (!milestoneSamples) milestoneSamples = {};
      if (!milestoneSamples[milestoneKey]) milestoneSamples[milestoneKey] = [];
      milestoneSamples[milestoneKey].push(results.tokens5h);
      if (milestoneSamples[milestoneKey].length > MAX_SAMPLES_PER_MILESTONE) {
        milestoneSamples[milestoneKey] = milestoneSamples[milestoneKey].slice(-MAX_SAMPLES_PER_MILESTONE);
      }
    }

    // Calibrate using average of all milestone samples (skip if 100% already set calibratedLimit7d)
    const needsCalibration = calibratedLimit7d == null
      || calibratedAtPct == null
      || (isMilestone && fiveHour !== 100);

    if (needsCalibration) {
      // Try multi-point average calibration first
      if (milestoneSamples && Object.keys(milestoneSamples).length > 0) {
        let sum = 0;
        let count = 0;
        for (const pctStr of Object.keys(milestoneSamples)) {
          const pct = Number(pctStr);
          const arr = milestoneSamples[pctStr];
          if (arr.length > 0 && pct > 0) {
            const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
            sum += (avg * 100 * 5) / pct;
            count++;
          }
        }
        if (count > 0) {
          calibratedLimit7d = sum / count;
          calibratedAt = nowMs;
          calibratedAtPct = fiveHour ?? undefined;
        }
      }
      // Fallback to single-point calibration when no samples available
      if (canCalibrate) {
        const singlePoint = (results.tokens5h * 100 * 5) / fiveHour;
        if (calibratedLimit7d == null || !milestoneSamples || Object.keys(milestoneSamples).length === 0) {
          calibratedLimit7d = singlePoint;
          calibratedAt = nowMs;
          calibratedAtPct = fiveHour;
        }
      }

      // Monotonic guard: calibratedLimit7d must not decrease within the same cycle
      if (calibration?.calibratedLimit7d != null
          && calibratedLimit7d != null
          && calibratedLimit7d < calibration.calibratedLimit7d) {
        deps.appendLog(
          `warning=CALIBRATION_REGRESSION old=${Math.floor(calibration.calibratedLimit7d / 1e6)}M new=${Math.floor(calibratedLimit7d / 1e6)}M at ${fiveHour}%`,
        );
        calibratedLimit7d = calibration.calibratedLimit7d;
        calibratedAt = calibration.calibratedAt;
        calibratedAtPct = calibration.calibratedAtPct;
      }
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

    // Monotonic enforcement: within the same cycle, usage must not decrease
    const prevCycleStart = calibration?.sevenDayStartAt;
    let monotonicApplied = false;
    const preMono7d = sevenDay;
    const preMonoTokens = sevenDayTokens;
    if (sevenDayStartAt != null && prevCycleStart != null && sevenDayStartAt === prevCycleStart) {
      const prevSevenDay = calibration?.sevenDay;
      const prevSevenDayTokens = calibration?.sevenDayTokens;
      if (sevenDay !== null && prevSevenDay != null && sevenDay < prevSevenDay) {
        sevenDay = prevSevenDay;
        monotonicApplied = true;
      }
      if (sevenDayTokens != null && prevSevenDayTokens != null && sevenDayTokens < prevSevenDayTokens) {
        sevenDayTokens = prevSevenDayTokens;
        monotonicApplied = true;
      }
    }

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
      calibratedAtPct,
      subscriptionTimeMs: effectiveSubscriptionTime,
      fiveHourResetAt,
      fiveHourStartAt,
      fiveHourFetchedAt: nowMs,
      sevenDayStartAt,
      sevenDayResetAt,
      milestoneSamples,
    });

    // Usage refresh log — always log on API call
    {
      const mM = (n: number | undefined | null) => n != null ? `${Math.floor(n / 1e6)}M` : '-';
      const fmtTs = (ms: number | null | undefined) =>
        ms != null ? new Date(ms).toISOString().slice(5, 16) : '-';

      // Line 1: source
      deps.appendLog('cache=MISS');

      // Line 2: API raw values
      deps.appendLog(
        `api 5hPct=${fiveHour ?? '-'} tokens5h=${mM(results.tokens5h)} tokens7d=${mM(results.tokens7d)} reset5h=${fmtTs(results.tokensLimitResetTime)} resetTime=${fmtTs(results.timeLimitResetTime)}`,
      );

      // Line 3: calculation process
      const limitM = calibratedLimit7d ? Math.floor(calibratedLimit7d / 1e6) : 0;
      const prev7dPct = calibration?.sevenDay;
      const prev7dTok = calibration?.sevenDayTokens;
      const monoTag = monotonicApplied
        ? `mono=${preMono7d}%→${sevenDay}%`
        : 'mono=-';
      const sampleCount = milestoneSamples ? Object.values(milestoneSamples).reduce((s, a) => s + a.length, 0) : 0;
      const sampleKeys = milestoneSamples ? Object.keys(milestoneSamples).join(',') : '-';
      deps.appendLog(
        `calc limit7d=${limitM}M@${calibratedAtPct ?? '-'} samples=${sampleCount}(${sampleKeys}) subMs=${effectiveSubscriptionTime ?? '-'} cycle=${fmtTs(sevenDayStartAt)} 7d=${sevenDay ?? '-'}%(${mM(sevenDayTokens)}) ${monoTag} prev7d=${prev7dPct ?? '-'}%(${mM(prev7dTok)})`,
      );
    }

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
      deps.appendLog(`error=auth limit7d=${calibration?.calibratedLimit7d ? Math.floor(calibration.calibratedLimit7d / 1e6) : '-'}M@${calibration?.calibratedAtPct ?? '-'} subMs=${calibration?.subscriptionTimeMs ?? '-'} msg=${(err as Error).message}`);
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
        calibratedAtPct: calibration?.calibratedAtPct,
        subscriptionTimeMs: calibration?.subscriptionTimeMs,
      });
      return null;
    }

    if ((err as Error)?.name === 'GlmRetryableError') {
      deps.appendLog(`error=retryable limit7d=${calibration?.calibratedLimit7d ? Math.floor(calibration.calibratedLimit7d / 1e6) : '-'}M@${calibration?.calibratedAtPct ?? '-'} subMs=${calibration?.subscriptionTimeMs ?? '-'} msg=${(err as Error).message}`);
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
        calibratedAtPct: calibration?.calibratedAtPct,
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
