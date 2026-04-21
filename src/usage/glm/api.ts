/**
 * GLM API client — pure fetch logic, no caching or calibration.
 *
 * Exported functions:
 *  - fetchQuota(baseDomain, headers)        → QuotaData
 *  - fetchFull(baseDomain, headers, cycleStart?) → FetchedData
 *  - getGlmHeaders()                         → headers | null
 *  - extractTotalTokens(data)                → number
 *  - formatTimestamp(d)                      → string
 *  - fetchWithTimeout(url, headers)          → Response
 */

import type { FetchedData, QuotaData } from './types.js';
import { GlmAuthError, GlmRetryableError } from './types.js';

// ---- Constants ----

const FETCH_TIMEOUT_MS = 5000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// ---- API response types (internal) ----

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
  totalTokens?: number;
}

interface ModelUsageTotalUsage {
  totalTokensUsage?: number;
  modelSummaryList?: { modelName: string; totalTokens: number; sortOrder: number }[];
}

export interface ModelUsageResponse {
  data?: {
    totalUsage?: ModelUsageTotalUsage;
    modelSummaryList?: { modelName: string; totalTokens: number }[];
  } | ModelUsageEntry[];
}

// ---- Helpers ----

/** Format a Date as "YYYY-MM-DD HH:MM:SS" for API query params. */
export function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Extract total tokens from model-usage response.
 * Handles both formats:
 *  1. Object format: data.totalUsage.totalTokensUsage (bigmodel.cn)
 *  2. Array format: data[].totalTokens (z.ai / older API)
 */
export function extractTotalTokens(data?: ModelUsageResponse['data']): number {
  if (!data) return 0;

  if (!Array.isArray(data) && typeof data === 'object') {
    const obj = data as Exclude<ModelUsageResponse['data'], ModelUsageEntry[]>;
    const totalUsage = obj?.totalUsage;
    if (totalUsage && typeof totalUsage.totalTokensUsage === 'number') {
      return totalUsage.totalTokensUsage;
    }
    const summary = obj?.modelSummaryList;
    if (Array.isArray(summary)) {
      return summary.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
    }
  }

  if (Array.isArray(data)) {
    return data.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
  }

  return 0;
}

/** Format token count in short notation: >=1B → "1B", >=1M → "347M", >=1K → "850K", else → "999" */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${Math.floor(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}K`;
  return String(n);
}

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- HTTP helpers ----

/** Fetch with AbortController timeout. */
export async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Build GLM API auth headers from environment. Returns null when no token. */
export function getGlmHeaders(): Record<string, string> | null {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!authToken) return null;
  return {
    'Authorization': authToken,
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en',
  };
}

// ---- Error classification ----

function classifyStatus(status: number): never {
  if (status === 401 || status === 403) {
    throw new GlmAuthError(`Auth failed: ${status}`);
  }
  if (status === 429 || status >= 500) {
    throw new GlmRetryableError(`Server/rate-limit error: ${status}`);
  }
  throw new GlmRetryableError(`Unexpected status: ${status}`);
}

// ---- Quota parsing (shared between fetchQuota and fetchFull) ----

function parseQuotaResponse(quotaRes: Response): Promise<{
  fiveHourPct: number | null;
  tokensLimitResetTime: number | null;
  timeLimitResetTime: number | null;
}> {
  return quotaRes.json().then((quotaJson: QuotaResponse) => {
    let fiveHourPct: number | null = null;
    let tokensLimitResetTime: number | null = null;
    let timeLimitResetTime: number | null = null;

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

    return { fiveHourPct, tokensLimitResetTime, timeLimitResetTime };
  }).catch(() => ({
    fiveHourPct: null as number | null,
    tokensLimitResetTime: null as number | null,
    timeLimitResetTime: null as number | null,
  }));
}

// ---- Public API ----

/**
 * Lightweight fetch: quota endpoint only (1 HTTP request).
 * Used for 5h-only refreshes.
 */
export async function fetchQuota(
  baseDomain: string,
  headers: Record<string, string>,
): Promise<QuotaData> {
  const quotaUrl = `${baseDomain}/api/monitor/usage/quota/limit`;
  const quotaRes = await fetchWithTimeout(quotaUrl, headers);

  if (quotaRes.status === 401 || quotaRes.status === 403) {
    throw new GlmAuthError(`Auth failed: ${quotaRes.status}`);
  }
  if (quotaRes.status === 429 || quotaRes.status >= 500) {
    throw new GlmRetryableError(`Server/rate-limit error: ${quotaRes.status}`);
  }

  const parsed = await parseQuotaResponse(quotaRes);
  return parsed;
}

/**
 * Full fetch: quota + model-usage (two-phase parallel + serial).
 *
 * Phase 1 — parallel: quota endpoint + 7d model-usage (cycleStart → now).
 * Phase 2 — serial:   exact 5h model-usage (nextResetTime - 5h → now).
 *
 * When cycleStart is null, uses now-7d as fallback for the 7d query range.
 */
export async function fetchFull(
  baseDomain: string,
  headers: Record<string, string>,
  cycleStart?: number,
): Promise<FetchedData> {
  const now = new Date();
  const start7d = cycleStart != null
    ? new Date(cycleStart)
    : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Phase 1: quota + 7d usage in parallel
  const quotaUrl = `${baseDomain}/api/monitor/usage/quota/limit`;
  const usage7dUrl = `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(start7d))}&endTime=${encodeURIComponent(formatTimestamp(now))}`;

  const [quotaRes, usage7dRes] = await Promise.all([
    fetchWithTimeout(quotaUrl, headers),
    fetchWithTimeout(usage7dUrl, headers),
  ]);

  // Check for auth / server errors on quota response
  if (quotaRes.status === 401 || quotaRes.status === 403) {
    throw new GlmAuthError(`Auth failed: ${quotaRes.status}`);
  }
  if (quotaRes.status === 429 || quotaRes.status >= 500) {
    throw new GlmRetryableError(`Server/rate-limit error: ${quotaRes.status}`);
  }

  // Parse quota response
  const { fiveHourPct, tokensLimitResetTime, timeLimitResetTime } = await parseQuotaResponse(quotaRes);

  // Phase 2: fetch exact 5h window using TOKENS_LIMIT.nextResetTime
  let tokens5h = 0;
  if (tokensLimitResetTime != null) {
    const windowStart = new Date(tokensLimitResetTime - FIVE_HOUR_MS);
    const usage5hUrl = `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(windowStart))}&endTime=${encodeURIComponent(formatTimestamp(now))}`;
    try {
      const usage5hRes = await fetchWithTimeout(usage5hUrl, headers);
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

  return {
    fiveHourPct,
    tokens5h,
    tokens7d,
    tokensLimitResetTime,
    timeLimitResetTime,
  };
}
