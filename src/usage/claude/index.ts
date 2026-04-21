import type { StdinData, UsageData } from '../../types.js';

function parseRateLimitPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(Math.min(100, Math.max(0, value)));
}

function parseRateLimitResetAt(value: number | null | undefined): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000);
}

/**
 * Extract Anthropic usage data from Claude Code's stdin rate_limits.
 * Returns null when rate_limits is absent (non-Anthropic platform or missing data).
 */
export function getUsageFromStdin(stdin: StdinData): UsageData | null {
  const rateLimits = stdin.rate_limits;
  if (!rateLimits) {
    return null;
  }

  const fiveHour = parseRateLimitPercent(rateLimits.five_hour?.used_percentage);
  const sevenDay = parseRateLimitPercent(rateLimits.seven_day?.used_percentage);
  if (fiveHour === null && sevenDay === null) {
    return null;
  }

  return {
    fiveHour,
    sevenDay,
    fiveHourStartAt: null,
    fiveHourResetAt: parseRateLimitResetAt(rateLimits.five_hour?.resets_at),
    sevenDayStartAt: null,
    sevenDayResetAt: parseRateLimitResetAt(rateLimits.seven_day?.resets_at),
    platform: 'anthropic',
    fiveHourWindowType: 'fixed',
    sevenDayWindowType: 'fixed',
  };
}
