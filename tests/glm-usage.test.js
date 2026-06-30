import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlmUsage } from '../dist/usage/glm/index.js';
import { formatTokenCount } from '../dist/usage/glm/api.js';
import { getNaturalWeekRange, resolveTimezone } from '../dist/usage/glm/timezone.js';

const NOW = 1_700_000_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// ---- Helpers ----

/** Quota with a unit:6 weekly entry. */
function quotaWithUnit6(weeklyPct = 21, weeklyResetTime = NOW + 86400000) {
  return { fiveHourPct: 25, tokensLimitResetTime: NOW + FIVE_HOUR_MS, timeLimitResetTime: null, weeklyPct, weeklyResetTime, hasUnit6: true };
}
/** Quota WITHOUT a unit:6 weekly entry. */
function quotaNoUnit6() {
  return { fiveHourPct: 25, tokensLimitResetTime: NOW + FIVE_HOUR_MS, timeLimitResetTime: null, weeklyPct: null, weeklyResetTime: null, hasUnit6: false };
}

function createMockDeps(overrides = {}) {
  return {
    detectPlatform: () => 'glm',
    getGlmBaseDomain: () => 'https://api.z.ai',
    fetchQuotaOnly: async () => quotaWithUnit6(),
    fetchModelUsage: async () => 100_000_000,
    fetch5hTokens: async () => 50_000_000,
    getGlmHeaders: () => ({ 'Authorization': 'test-token', 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' }),
    ...overrides,
  };
}

// ---- formatTokenCount ----

describe('formatTokenCount', () => {
  it('formats billions (floor)', () => assert.equal(formatTokenCount(1_200_000_000), '1B'));
  it('formats billions (whole)', () => assert.equal(formatTokenCount(2_000_000_000), '2B'));
  it('formats millions', () => assert.equal(formatTokenCount(310_000_000), '310M'));
  it('formats millions (floor)', () => assert.equal(formatTokenCount(1_500_000), '1M'));
  it('formats thousands', () => assert.equal(formatTokenCount(850_000), '850K'));
  it('formats thousands (floor)', () => assert.equal(formatTokenCount(1_500), '1K'));
  it('formats small numbers', () => assert.equal(formatTokenCount(999), '999'));
  it('formats zero', () => assert.equal(formatTokenCount(0), '0'));
});

// ---- timezone helpers ----

describe('getNaturalWeekRange', () => {
  const fmt = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  it('starts at Monday 00:00 in Asia/Shanghai', () => {
    const r = getNaturalWeekRange('Asia/Shanghai', Date.UTC(2024, 5, 5, 2, 30, 0));
    assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(r.startMs)), 'Mon');
    assert.equal(fmt(r.startMs, 'Asia/Shanghai'), 'Mon 00:00');
    assert.equal(r.endMs - r.startMs, WEEK_MS);
  });
  it('starts at Monday 00:00 in America/New_York', () => {
    const r = getNaturalWeekRange('America/New_York', Date.UTC(2024, 5, 5, 2, 30, 0));
    assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(r.startMs)), 'Mon');
    assert.equal(fmt(r.startMs, 'America/New_York'), 'Mon 00:00');
  });
  it('handles cross-month (week Monday in prior month)', () => {
    const r = getNaturalWeekRange('Asia/Shanghai', Date.UTC(2024, 5, 1, 4, 0, 0)); // Sat Jun 1
    assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(new Date(r.startMs)), '05/27');
  });
});

describe('resolveTimezone', () => {
  it('falls back to Asia/Shanghai when TZ unset', () => {
    const saved = process.env.TZ;
    delete process.env.TZ;
    try { assert.equal(resolveTimezone(), 'Asia/Shanghai'); }
    finally { if (saved) process.env.TZ = saved; }
  });
  it('uses TZ env when set', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try { assert.equal(resolveTimezone(), 'America/New_York'); }
    finally { if (saved) process.env.TZ = saved; else delete process.env.TZ; }
  });
});

// ---- getGlmUsage: dispatch ----

describe('getGlmUsage: dispatch', () => {
  it('returns null for non-GLM platform', async () => {
    assert.equal(await getGlmUsage({ detectPlatform: () => 'anthropic' }), null);
  });
  it('returns null when no base domain', async () => {
    assert.equal(await getGlmUsage(createMockDeps({ getGlmBaseDomain: () => null })), null);
  });
  it('returns null when no auth token', async () => {
    assert.equal(await getGlmUsage(createMockDeps({ getGlmHeaders: () => null })), null);
  });
  it('returns null on auth error', async () => {
    const e = new Error('Auth failed: 401'); e.name = 'GlmAuthError';
    assert.equal(await getGlmUsage(createMockDeps({ fetchQuotaOnly: async () => { throw e; } })), null);
  });
  it('returns null on retryable error', async () => {
    const e = new Error('Server error: 502'); e.name = 'GlmRetryableError';
    assert.equal(await getGlmUsage(createMockDeps({ fetchQuotaOnly: async () => { throw e; } })), null);
  });
});

// ---- getGlmUsage: path A (unit:6) ----

describe('getGlmUsage: path A (has unit:6)', () => {
  it('derives sevenDay from weeklyPct and window from nextResetTime', async () => {
    const calls = [];
    const deps = createMockDeps({
      fetchQuotaOnly: async () => quotaWithUnit6(76, NOW + 86400000),
      fetchModelUsage: async (_b, _h, s, e) => { calls.push({ s, e }); return 250_000_000; },
    });
    const r = await getGlmUsage(deps);
    assert.equal(r.sevenDay, 76);
    assert.equal(r.sevenDayWindowType, 'cycle');
    assert.equal(r.sevenDayResetAt.getTime(), NOW + 86400000);
    assert.equal(r.sevenDayStartAt.getTime(), NOW + 86400000 - WEEK_MS);
    assert.equal(r.sevenDayTokens, 250_000_000);
    assert.equal(r.platform, 'glm');
    // window = [nextResetTime - 7d, nextResetTime] (full cycle, aligns with percentage)
    assert.equal(calls[0].s, NOW + 86400000 - WEEK_MS);
    assert.equal(calls[0].e, NOW + 86400000);
  });
  it('clamps weeklyPct to [0, 100]', async () => {
    const r = await getGlmUsage(createMockDeps({ fetchQuotaOnly: async () => quotaWithUnit6(100) }));
    assert.ok(r.sevenDay <= 100 && r.sevenDay >= 0);
  });
  it('does NOT fall back to path B when unit:6 present', async () => {
    // If path B had run, sevenDay would be null. Path A yields the weeklyPct.
    const r = await getGlmUsage(createMockDeps({
      fetchQuotaOnly: async () => quotaWithUnit6(42),
      fetchModelUsage: async () => 1,
    }));
    assert.ok(r);
    assert.equal(r.sevenDay, 42, 'path A owns result (sevenDay from weeklyPct)');
    assert.equal(r.sevenDayWindowType, 'cycle');
    assert.notEqual(r.sevenDay, null);
  });
  it('unit:6 missing percentage → returns null, no path B fallback', async () => {
    let pathBCalled = false;
    const r = await getGlmUsage(createMockDeps({
      fetchQuotaOnly: async () => ({ ...quotaWithUnit6(), weeklyPct: null }),
      fetchModelUsage: async () => { pathBCalled = true; return 1; },
    }));
    assert.equal(r, null);
    assert.equal(pathBCalled, false, 'must not query model-usage (no path B fallback)');
  });
  it('unit:6 missing nextResetTime → returns null, no path B fallback', async () => {
    let pathBCalled = false;
    const r = await getGlmUsage(createMockDeps({
      fetchQuotaOnly: async () => ({ ...quotaWithUnit6(), weeklyResetTime: null }),
      fetchModelUsage: async () => { pathBCalled = true; return 1; },
    }));
    assert.equal(r, null);
    assert.equal(pathBCalled, false, 'must not query model-usage (no path B fallback)');
  });
  it('path A internal error → caught, returns null', async () => {
    const r = await getGlmUsage(createMockDeps({
      fetchQuotaOnly: async () => quotaWithUnit6(),
      fetchModelUsage: async () => { throw new Error('boom'); },
    }));
    assert.equal(r, null);
  });
});

// ---- getGlmUsage: path B (no unit:6) ----

describe('getGlmUsage: path B (no unit:6)', () => {
  it('sets sevenDay=null, windowType=rolling, aggregates natural week', async () => {
    const calls = [];
    const r = await getGlmUsage(createMockDeps({
      fetchQuotaOnly: async () => quotaNoUnit6(),
      fetchModelUsage: async (_b, _h, s, e) => { calls.push({ s, e }); return 80_000_000; },
    }));
    assert.equal(r.sevenDay, null);
    assert.equal(r.sevenDayWindowType, 'rolling');
    assert.equal(r.sevenDayResetAt, null);
    assert.equal(r.sevenDayTokens, 80_000_000);
    assert.equal(r.platform, 'glm');
    // window length is exactly 7 days
    assert.equal(calls[0].e - calls[0].s, WEEK_MS);
  });
  it('does NOT reference unit:6 when absent', async () => {
    const r = await getGlmUsage(createMockDeps({ fetchQuotaOnly: async () => quotaNoUnit6() }));
    assert.equal(r.sevenDay, null);
    assert.equal(r.sevenDayResetAt, null);
  });
  it('path B internal error → caught, returns null', async () => {
    const r = await getGlmUsage(createMockDeps({
      fetchQuotaOnly: async () => quotaNoUnit6(),
      fetchModelUsage: async () => { throw new Error('boom'); },
    }));
    assert.equal(r, null);
  });
});
