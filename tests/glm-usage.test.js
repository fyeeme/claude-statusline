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
    fetchFull: async () => ({ fiveHourPct: 25, tokens5h: 50_000_000, tokens7d: 100_000_000, tokensLimitResetTime: null, timeLimitResetTime: null }),
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

  it('does full refresh on cache miss', async () => {
    let writtenCache = null;
    let writtenState = null;
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: 20, tokens5h: 100_000_000, tokens7d: 250_000_000, tokensLimitResetTime: null, timeLimitResetTime: null }),
      writeCache: (d) => { writtenCache = d; },
      writeState: (s) => { writtenState = s; },
      readState: () => makeState({ calibratedLimit7d: null, subscriptionTimeMs: FIXED_SUB_TIME }),
    }));

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 20);
    assert.equal(result.platform, 'glm');
    assert.notEqual(writtenCache, null);
    assert.equal(writtenCache.isError, false);
    assert.notEqual(writtenState, null);
    assert.notEqual(writtenState.calibratedLimit7d, null);
  });

  it('calibrates with EMA on full refresh', async () => {
    let writtenState = null;
    // First call: no prior calibration -> single-point estimate
    // estimate = 100M * 500 / 20 = 2500M
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: 20, tokens5h: 100_000_000, tokens7d: 250_000_000, tokensLimitResetTime: null, timeLimitResetTime: null }),
      writeState: (s) => { writtenState = s; },
      readState: () => makeState({ calibratedLimit7d: null }),
    }));

    assert.notEqual(result, null);
    assert.equal(writtenState.calibratedLimit7d, 2_500_000_000);
    // 7d% = 250M / 2500M * 100 = 10
    assert.equal(result.sevenDay, 10);
  });

  it('applies monotonic guard within same cycle', async () => {
    const cycleStart = FIXED_SUB_TIME + Math.floor((NOW - FIXED_SUB_TIME) / CYCLE_MS) * CYCLE_MS;
    const cached = makeCached({ sevenDay: 30, sevenDayTokens: 150_000_000, sevenDayStartAt: cycleStart, fiveHourFetchedAt: NOW - 200_000, timestamp: NOW - 200_000 });

    // Full refresh returns lower 7d (due to API jitter)
    const result = await getGlmUsage(createMockDeps({
      readCache: () => cached,
      fetchQuota: async () => ({ fiveHourPct: 99, tokensLimitResetTime: null, timeLimitResetTime: null }), // triggers full via milestone
      fetchFull: async () => ({ fiveHourPct: 25, tokens5h: 50_000_000, tokens7d: 140_000_000, tokensLimitResetTime: null, timeLimitResetTime: null }),
      readState: () => makeState({ calibratedLimit7d: 500_000_000 }),
    }));

    // Monotonic guard: 7d should NOT decrease within same cycle
    assert.ok(result.sevenDay >= 30, `Expected >= 30, got ${result.sevenDay}`);
  });

  it('allows decrease on cycle change', async () => {
    const oldCycle = FIXED_SUB_TIME + Math.floor((NOW - FIXED_SUB_TIME) / CYCLE_MS) * CYCLE_MS;
    const newCycle = oldCycle + CYCLE_MS;
    const cached = makeCached({ sevenDay: 80, sevenDayTokens: 400_000_000, sevenDayStartAt: oldCycle, fiveHourFetchedAt: NOW - 200_000, timestamp: NOW - 200_000 });

    const result = await getGlmUsage(createMockDeps({
      readCache: () => cached,
      fetchQuota: async () => ({ fiveHourPct: 99, tokensLimitResetTime: null, timeLimitResetTime: null }),
      fetchFull: async () => ({ fiveHourPct: 10, tokens5h: 50_000_000, tokens7d: 20_000_000, tokensLimitResetTime: null, timeLimitResetTime: null }),
      readState: () => makeState({ calibratedLimit7d: 500_000_000 }),
      now: () => newCycle + 60_000,
    }));

    // New cycle: 7d can drop
    assert.ok(result.sevenDay < 80, `Expected < 80 on new cycle, got ${result.sevenDay}`);
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

  it('returns null when both fiveHour and sevenDay are null', async () => {
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: null, tokens5h: 0, tokens7d: 0, tokensLimitResetTime: null, timeLimitResetTime: null }),
      readState: () => makeState({ calibratedLimit7d: null }),
    }));

    assert.equal(result, null);
  });

  it('clamps 7d percentage to 100', async () => {
    const result = await getGlmUsage(createMockDeps({
      readCache: () => null,
      fetchFull: async () => ({ fiveHourPct: 100, tokens5h: 1_000, tokens7d: 10_000_000, tokensLimitResetTime: null, timeLimitResetTime: null }),
      readState: () => makeState({ calibratedLimit7d: 500_000_000 }),
    }));

    assert.notEqual(result, null);
    assert.ok(result.sevenDay <= 100, `Expected <= 100, got ${result.sevenDay}`);
    assert.ok(result.sevenDay >= 0, `Expected >= 0, got ${result.sevenDay}`);
  });
});
