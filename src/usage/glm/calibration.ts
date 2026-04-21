import type { CalibrationState } from './types.js';

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

/** EMA alpha — new observations get 20% weight, history gets 80%. */
const ALPHA = 0.2;

/**
 * Update calibration state using Exponential Moving Average.
 *
 * On every full refresh where fiveHourPct >= 10, we compute an instantaneous
 * estimate of the 7d token limit and blend it with the previous value via EMA.
 * Below 10% the signal is too noisy — skip update, preserve previous.
 *
 * Anti-regression: calibratedLimit7d never decreases. If the new EMA value
 * is lower, the previous value is kept and a warning is logged.
 */
export function updateCalibration(
  tokens5h: number,
  fiveHourPct: number,
  previous: CalibrationState | null,
  nowMs: number,
  warn?: (msg: string) => void,
): CalibrationState {
  // Rule 1: Not enough signal — skip update (< 10% is too noisy)
  if (fiveHourPct < 10 || tokens5h <= 0) {
    if (previous) return previous;
    return { calibratedLimit7d: null, calibratedAt: nowMs, subscriptionTimeMs: null };
  }

  const estimate = (tokens5h * 500) / fiveHourPct;

  // Rule 2: First valid observation — single-point estimate
  if (previous == null || previous.calibratedLimit7d == null) {
    return {
      calibratedLimit7d: estimate,
      calibratedAt: nowMs,
      subscriptionTimeMs: previous?.subscriptionTimeMs ?? null,
    };
  }

  // Rule 3: EMA update with anti-regression
  const prev = previous.calibratedLimit7d;
  const ema = ALPHA * estimate + (1 - ALPHA) * prev;

  if (ema < prev) {
    warn?.(`calib-regress: ema=${Math.floor(ema / 1e6)}M < prev=${Math.floor(prev / 1e6)}M, estimate=${Math.floor(estimate / 1e6)}M at 5h=${fiveHourPct}%/${Math.floor(tokens5h / 1e6)}M — keeping prev`);
    return {
      calibratedLimit7d: prev,
      calibratedAt: nowMs,
      subscriptionTimeMs: previous.subscriptionTimeMs,
    };
  }

  return {
    calibratedLimit7d: ema,
    calibratedAt: nowMs,
    subscriptionTimeMs: previous.subscriptionTimeMs,
  };
}

/**
 * Infer the subscription anniversary timestamp from a monthly reset timestamp.
 *
 * Given the UTC day+time of a known reset, this finds the most recent
 * occurrence of that day+time before now and returns it as ms-since-epoch.
 * Handles month-end edge cases (e.g. day=31 in a 30-day month).
 */
export function inferSubscriptionTime(timeLimitResetMs: number): number {
  const resetDate = new Date(timeLimitResetMs);
  const day = resetDate.getUTCDate();
  const hours = resetDate.getUTCHours();
  const minutes = resetDate.getUTCMinutes();
  const seconds = resetDate.getUTCSeconds();

  // Find the most recent occurrence of this day+time before now
  const nowMs = Date.now();
  const now = new Date(nowMs);

  // Try current month
  let candidateMonth = now.getUTCMonth();
  let candidateYear = now.getUTCFullYear();
  let candidate = Date.UTC(candidateYear, candidateMonth, day, hours, minutes, seconds);
  if (candidate > nowMs) {
    candidateMonth = candidateMonth - 1;
    if (candidateMonth < 0) { candidateMonth = 11; candidateYear--; }
    candidate = Date.UTC(candidateYear, candidateMonth, day, hours, minutes, seconds);
  }

  // Handle month-end edge case: e.g., day=31 in a 30-day month
  // Date.UTC rolls over (Jan 31 → Feb 3), so check if the month matches
  const candidateDate = new Date(candidate);
  if (candidateDate.getUTCMonth() !== candidateMonth) {
    const lastDay = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
    candidate = Date.UTC(candidateYear, candidateMonth, lastDay, hours, minutes, seconds);
  }

  return candidate;
}

/** Compute the current 7-day cycle start from subscription time.
 *  Returns the most recent subscriptionTime + n * 7d that is <= nowMs. */
export function computeCycleStart(subscriptionTimeMs: number, nowMs: number): number {
  const n = Math.floor((nowMs - subscriptionTimeMs) / CYCLE_MS);
  return subscriptionTimeMs + n * CYCLE_MS;
}
