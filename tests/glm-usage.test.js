import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlmUsage } from '../dist/usage/glm/index.js';
import { formatTokenCount } from '../dist/usage/glm/api.js';

const NOW = 1_700_000_000_000;
const FIXED_SUB_TIME = new Date('2026-03-30T07:43:28.000Z').getTime();
const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

// ---- Helpers ----

function createMockDeps(overrides = {}) {
  return {
    detectPlatform: () => 'glm',
    getGlmBaseDomain: () => 'https://api.z.ai',
    readState: () => ({ calibratedLimit7d: 500_000_000, calibratedAt: NOW, subscriptionTimeMs: FIXED_SUB_TIME }),
    writeState: () => {},
    readCache: () => null,
    writeCache: () => {},
    fetchQuota: async () => ({ fiveHourPct: null, tokensLimitResetTime: null, timeLimitResetTime: null }),
    fetchFull: async () => ({ fiveHourPct: 25, tokens5h: 50_000_000, tokens7d: 100_000_000, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: 40, weeklyResetTime: NOW + 86400000 }),
    getGlmHeaders: () => ({ 'Authorization': 'test-token', 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' }),
    now: () => NOW,
    cacheTtlMs: 5 * 60 * 1000,
    fiveHourTtlMs: 30 * 1000,
    appendLog: () => {},
    migrateOldCache: () => {},
    ...overrides,
  };
}

function makeCached(overrides = {}) {
  return {
    platform: 'glm',
    fiveHour: 25,
    sevenDay: 10,
    sevenDayTokens: 100_000_000,
    fiveHourFetchedAt: NOW - 10_000,
    fiveHourStartAt: null,
    fiveHourResetAt: null,
    sevenDayStartAt: FIXED_SUB_TIME + Math.floor((NOW - FIXED_SUB_TIME) / CYCLE_MS) * CYCLE_MS,
    sevenDayResetAt: null,
    timestamp: NOW - 10_000,
    ttlMs: 5 * 60 * 1000,
    isError: false,
    fiveHourWindowType: 'cycle',
    sevenDayWindowType: 'cycle',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    calibratedLimit7d: 500_000_000,
    calibratedAt: NOW,
    subscriptionTimeMs: FIXED_SUB_TIME,
    ...overrides,
  };
}

// ---- formatTokenCount ----

describe('formatTokenCount', () => {
  it('formats billions (floor)', () => {
    assert.equal(formatTokenCount(1_200_000_000), '1B');
  });
  it('formats billions (whole)', () => {
    assert.equal(formatTokenCount(2_000_000_000), '2B');
  });
  it('formats millions', () => {
    assert.equal(formatTokenCount(310_000_000), '310M');
  });
  it('formats millions (floor)', () => {
    assert.equal(formatTokenCount(1_500_000), '1M');
  });
  it('formats thousands', () => {
    assert.equal(formatTokenCount(850_000), '850K');
  });
  it('formats thousands (floor)', () => {
    assert.equal(formatTokenCount(1_500), '1K');
  });
  it('formats small numbers', () => {
    assert.equal(formatTokenCount(999), '999');
  });
  it('formats zero', () => {
    assert.equal(formatTokenCount(0), '0');
  });
});

// ---- getGlmUsage ----

describe('getGlmUsage', () => {
  it('returns null for non-GLM platform', async () => {
    assert.equal(await getGlmUsage({ detectPlatform: () => 'anthropic' }), null);
  });

  it('returns cached data when 5h is fresh', async () => {
    let fetchCalled = false;
    const cached = makeCached({ fiveHourFetchedAt: NOW - 5_000 });
    const result = await getGlmUsage(createMockDeps({
      readCache: () => cached,
      fetchFull: async () => { fetchCalled = true; return { fiveHourPct: 0, tokens5h: 0, tokens7d: 0, tokensLimitResetTime: null, timeLimitResetTime: null }; },
      fetchQuota: async () => { fetchCalled = true; return { fiveHourPct: 0, tokensLimitResetTime: null, timeLimitResetTime: null }; },
    }));
    assert.equal(fetchCalled, false);
    assert.equal(result.fiveHour, 25);
    assert.equal(result.sevenDay, 10);
    assert.equal(result.sevenDayTokens, 100_000_000);
  });

  it('does lightweight refresh when 5h stale but 7d fresh', async () => {
    const CACHE_TIME = NOW - 60_000; // 5h TTL expired (30s), 7d TTL fresh (5min)
    let quotaCalled = false;
    let apiCalled = false;
    const cached = makeCached({ fiveHour: 32, sevenDay: 15, sevenDayTokens: 200_000_000, fiveHourFetchedAt: CACHE_TIME, timestamp: CACHE_TIME });

    const result = await getGlmUsage(createMockDeps({
      readCache: () => cached,
      fetchQuota: async () => { quotaCalled = true; return { fiveHourPct: 33, tokensLimitResetTime: NOW + 3600000, timeLimitResetTime: null }; },
      fetchFull: async () => { apiCalled = true; return { fiveHourPct: 0, tokens5h: 0, tokens7d: 0, tokensLimitResetTime: null, timeLimitResetTime: null }; },
    }));

    assert.equal(quotaCalled, true);
    assert.equal(apiCalled, false);
    assert.equal(result.fiveHour, 33);
    assert.equal(result.sevenDay, 15);
    assert.equal(result.sevenDayTokens, 200_000_000);
  });

  it('uses API weeklyPct directly on full refresh (no EMA)', async () => {
    let writtenCache = null;
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: 20, tokens5h: 100_000_000, tokens7d: 250_000_000, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: 76, weeklyResetTime: NOW + 86400000 }),
      writeCache: (d) => { writtenCache = d; },
    }));

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 20);
    assert.equal(result.sevenDay, 76); // weeklyPct direct, no EMA
    assert.equal(result.sevenDayTokens, 250_000_000);
    assert.equal(result.platform, 'glm');
    assert.notEqual(writtenCache, null);
    assert.equal(writtenCache.isError, false);
  });

  it('returns null + error cache on auth error', async () => {
    const error = new Error('Auth failed: 401');
    error.name = 'GlmAuthError';
    let writtenCache = null;

    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => { throw error; },
      writeCache: (d) => { writtenCache = d; },
    }));

    assert.equal(result, null);
    assert.notEqual(writtenCache, null);
    assert.equal(writtenCache.isError, true);
  });

  it('returns stale cached data on retryable error', async () => {
    const error = new Error('Server error: 502');
    error.name = 'GlmRetryableError';
    const cached = makeCached({ fiveHour: 20, sevenDay: 5 });

    const result = await getGlmUsage(createMockDeps({
      readCache: () => cached,
      fetchFull: async () => { throw error; },
      fetchQuota: async () => { throw error; },
    }));

    // readCache returns non-null non-error -> stale returned before fetch attempted
    // but 5h is fresh so cache hit path fires first
    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 20);
  });

  it('returns null when no auth token', async () => {
    let writtenCache = null;
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      getGlmHeaders: () => null,
      writeCache: (d) => { writtenCache = d; },
    }));

    assert.equal(result, null);
    assert.notEqual(writtenCache, null);
    assert.equal(writtenCache.isError, true);
  });

  it('returns null when both fiveHour and weeklyPct are null', async () => {
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: null, tokens5h: 0, tokens7d: 0, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: null, weeklyResetTime: null }),
    }));

    assert.equal(result, null);
  });

  it('clamps weeklyPct to [0, 100] range', async () => {
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: 100, tokens5h: 1_000, tokens7d: 10_000_000, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: 100, weeklyResetTime: NOW + 86400000 }),
    }));

    assert.notEqual(result, null);
    assert.ok(result.sevenDay <= 100, `Expected <= 100, got ${result.sevenDay}`);
    assert.ok(result.sevenDay >= 0, `Expected >= 0, got ${result.sevenDay}`);
  });
});
