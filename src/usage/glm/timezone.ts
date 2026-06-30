/**
 * Timezone resolution and natural-week window calculation for GLM path B
 * (no `unit:6` — falls back to user-timezone natural-week aggregation).
 */

/** Fallback timezone when neither TZ env nor anything else is set. */
export const DEFAULT_TZ = 'Asia/Shanghai';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * Resolve the timezone to use for natural-week aggregation.
 * Priority: `process.env.TZ` → `'Asia/Shanghai'` (matches GLM console default).
 */
export function resolveTimezone(): string {
  const tz = process.env.TZ;
  if (tz && tz.trim().length > 0) return tz;
  return DEFAULT_TZ;
}

/**
 * Offset (in ms) of `timeZone` from UTC at the given UTC instant.
 * Positive = east of UTC. Uses Intl parts; DST-correct at the instant.
 */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  let h = g('hour');
  if (h === 24) h = 0; // hour12:false can yield '24' on some runtimes
  const wallAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), h, g('minute'), g('second'));
  return wallAsUtc - utcMs;
}

/**
 * Compute the natural-week window `[startMs, endMs)` containing `nowMs`
 * in the given timezone, with the week starting Monday 00:00 local.
 *
 * `endMs` is exactly 7 days after `startMs` (exclusive upper bound).
 * Handles cross-month, cross-year, and DST boundaries.
 */
export function getNaturalWeekRange(
  timeZone: string,
  nowMs: number,
): { startMs: number; endMs: number } {
  // 1. Local wall-clock of `nowMs`, expressed as if it were UTC ms.
  const localMs = nowMs + tzOffsetMs(nowMs, timeZone);
  const local = new Date(localMs);

  // 2. Local midnight (wall-clock) for today.
  const localMidnightMs = localMs
    - local.getUTCHours() * 3600000
    - local.getUTCMinutes() * 60000
    - local.getUTCSeconds() * 1000
    - local.getUTCMilliseconds();

  // 3. Days elapsed since Monday (Mon=0 .. Sun=6). getUTCDay: Sun=0..Sat=6.
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const weekStartLocalMs = localMidnightMs - daysSinceMonday * MS_PER_DAY;

  // 4. Convert local wall-clock back to a UTC instant, iterating twice so
  //    the offset (which depends on the instant) converges near DST edges.
  let startMs = weekStartLocalMs - tzOffsetMs(weekStartLocalMs, timeZone);
  startMs = weekStartLocalMs - tzOffsetMs(startMs, timeZone);

  return { startMs, endMs: startMs + MS_PER_WEEK };
}
