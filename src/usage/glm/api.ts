/**
 * GLM API client — pure fetch logic, no caching or calibration.
 *
 * Exported functions:
 *  - fetchQuotaOnly(baseDomain, headers)         → QuotaInfo
 *  - fetchModelUsage(baseDomain, headers, s, e)  → number (totalTokens)
 *  - fetch5hTokens(baseDomain, headers, resetMs) → number
 *  - getGlmHeaders()                             → headers | null
 *  - extractTotalTokens(data)                    → number
 *  - formatTimestamp(d)                          → string
 *  - formatTokenCount(n)                         → string
 *  - fetchWithTimeout(url, headers)              → Response
 */

import { GlmAuthError, GlmRetryableError } from './types.js';

// ---- Constants ----

const FETCH_TIMEOUT_MS = 5000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// ---- API response types (internal) ----

interface QuotaLimit {
  type: string;
  unit?: number;
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

/** Quota-only result (no token aggregation). */
export interface QuotaInfo {
  fiveHourPct: number | null;
  tokensLimitResetTime: number | null;
  timeLimitResetTime: number | null;
  weeklyPct: number | null;
  weeklyResetTime: number | null;
  /** True when a `unit:6` TOKENS_LIMIT entry exists (regardless of whether
   *  its fields parsed). When true, path A owns the result even if fields
   *  are missing (returns null rather than falling back to path B). */
  hasUnit6: boolean;
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

// ---- Public: quota-only fetch ----

/**
 * Fetch only the quota/limit endpoint. Returns parsed limit fields.
 * Throws GlmAuthError on 401/403, GlmRetryableError on 429/5xx.
 */
export async function fetchQuotaOnly(
  baseDomain: string,
  headers: Record<string, string>,
): Promise<QuotaInfo> {
  const quotaUrl = `${baseDomain}/api/monitor/usage/quota/limit`;
  const res = await fetchWithTimeout(quotaUrl, headers);

  if (res.status === 401 || res.status === 403) {
    throw new GlmAuthError(`Auth failed: ${res.status}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new GlmRetryableError(`Server/rate-limit error: ${res.status}`);
  }

  try {
    const quotaJson: QuotaResponse = await res.json();
    return parseQuotaLimits(quotaJson);
  } catch {
    return {
      fiveHourPct: null,
      tokensLimitResetTime: null,
      timeLimitResetTime: null,
      weeklyPct: null,
      weeklyResetTime: null,
      hasUnit6: false,
    };
  }
}

/** Parse the quota limits array into QuotaInfo. */
function parseQuotaLimits(quotaJson: QuotaResponse): QuotaInfo {
  let fiveHourPct: number | null = null;
  let tokensLimitResetTime: number | null = null;
  let timeLimitResetTime: number | null = null;
  let weeklyPct: number | null = null;
  let weeklyResetTime: number | null = null;
  let hasUnit6 = false;

  const limits = quotaJson?.data?.limits;
  if (Array.isArray(limits)) {
    // unit:3 = 5-hour rolling, unit:6 = weekly. Fallback to first TOKENS_LIMIT when unit absent.
    const fiveHourLimit = limits.find((l) => l.type === 'TOKENS_LIMIT' && l.unit === 3)
      ?? limits.find((l) => l.type === 'TOKENS_LIMIT');
    const weeklyLimit = limits.find((l) => l.type === 'TOKENS_LIMIT' && l.unit === 6);
    hasUnit6 = weeklyLimit != null;
    if (fiveHourLimit && typeof fiveHourLimit.percentage === 'number' && Number.isFinite(fiveHourLimit.percentage)) {
      fiveHourPct = clamp(Math.round(fiveHourLimit.percentage), 0, 100);
    }
    if (fiveHourLimit && typeof fiveHourLimit.nextResetTime === 'number' && Number.isFinite(fiveHourLimit.nextResetTime)) {
      tokensLimitResetTime = fiveHourLimit.nextResetTime;
    }
    if (weeklyLimit) {
      if (typeof weeklyLimit.percentage === 'number' && Number.isFinite(weeklyLimit.percentage)) {
        weeklyPct = clamp(Math.round(weeklyLimit.percentage), 0, 100);
      }
      if (typeof weeklyLimit.nextResetTime === 'number' && Number.isFinite(weeklyLimit.nextResetTime)) {
        weeklyResetTime = weeklyLimit.nextResetTime;
      }
    }
    const timeLimit = limits.find((l) => l.type === 'TIME_LIMIT');
    if (timeLimit && typeof timeLimit.nextResetTime === 'number' && Number.isFinite(timeLimit.nextResetTime)) {
      timeLimitResetTime = timeLimit.nextResetTime;
    }
  }

  return { fiveHourPct, tokensLimitResetTime, timeLimitResetTime, weeklyPct, weeklyResetTime, hasUnit6 };
}

// ---- Public: model-usage window fetch ----

/**
 * Query model-usage totalTokens over an arbitrary [startMs, endMs] window.
 * Returns 0 on any failure — never throws (paths rely on graceful fallback).
 */
export async function fetchModelUsage(
  baseDomain: string,
  headers: Record<string, string>,
  startMs: number,
  endMs: number,
): Promise<number> {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const url = `${baseDomain}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatTimestamp(start))}&endTime=${encodeURIComponent(formatTimestamp(end))}`;
  try {
    const res = await fetchWithTimeout(url, headers);
    if (!res.ok) return 0;
    const json: ModelUsageResponse = await res.json();
    return extractTotalTokens(json?.data);
  } catch {
    return 0;
  }
}

// ---- Public: 5h tokens fetch (shared by both weekly paths) ----

/**
 * Fetch exact 5h-window token usage using TOKENS_LIMIT.nextResetTime.
 * Returns 0 when resetTime is null or the request fails.
 */
export async function fetch5hTokens(
  baseDomain: string,
  headers: Record<string, string>,
  tokensLimitResetTime: number | null,
): Promise<number> {
  if (tokensLimitResetTime == null) return 0;
  const windowStart = tokensLimitResetTime - FIVE_HOUR_MS;
  return fetchModelUsage(baseDomain, headers, windowStart, Date.now());
}
