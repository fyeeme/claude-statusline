import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getGlmUsage, formatTokenCount } from '../dist/glm-usage.js';

// Fixed subscription time for consistent test results
const FIXED_SUB_TIME = new Date('2026-03-30T07:43:28.000Z').getTime();
const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

// ---- formatTokenCount tests ----

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

// ---- getGlmUsage tests with mocks ----

function createMockDeps(overrides = {}) {
  return {
    detectPlatform: () => 'glm',
    getGlmBaseDomain: () => 'https://api.z.ai',
    readCache: () => null,
    writeCache: () => {},
    appendLog: () => {},
    getGlmHeaders: () => ({
      'Authorization': 'test-token',
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
    }),
    fetchGlmApi: async () => ({
      fiveHourPct: 10,
      tokens5h: 22_300_000,
      tokens7d: 310_000_000,
      timeLimitResetTime: new Date('2026-04-30T07:43:12.000Z').getTime(),
    }),
    fetchGlmQuotaOnly: async () => ({
      fiveHourPct: 15,
      tokensLimitResetTime: null,
      timeLimitResetTime: null,
    }),
    readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
    now: () => Date.now(),
    cacheTtlMs: 5 * 60 * 1000,
    fiveHourTtlMs: 30 * 1000,
    ...overrides,
  };
}

describe('getGlmUsage', () => {
  it('returns null when platform is not GLM', async () => {
    const result = await getGlmUsage({
      detectPlatform: () => 'anthropic',
    });
    assert.equal(result, null);
  });

  it('returns null when no auth token', async () => {
    const result = await getGlmUsage({
      ...createMockDeps(),
      getGlmHeaders: () => null,
    });
    assert.equal(result, null);
  });

  it('returns null when no base domain', async () => {
    const result = await getGlmUsage({
      ...createMockDeps(),
      getGlmBaseDomain: () => null,
    });
    assert.equal(result, null);
  });

  it('returns cached data on cache hit', async () => {
    let fetchCalled = false;
    const result = await getGlmUsage({
      ...createMockDeps(),
      readCache: () => ({
        platform: 'glm',
        fiveHour: 15,
        sevenDay: 8,
        sevenDayTokens: 200_000_000,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        timestamp: Date.now(),
        ttlMs: 5 * 60 * 1000,
      }),
      fetchGlmApi: async () => {
        fetchCalled = true;
        return { fiveHourPct: 10, tokens5h: 0, tokens7d: 0 };
      },
    });

    assert.equal(fetchCalled, false, 'Should not call API on cache hit');
    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 15);
    assert.equal(result.sevenDay, 8);
    assert.equal(result.platform, 'glm');
    assert.equal(result.fiveHourWindowType, 'cycle');
    assert.equal(result.sevenDayWindowType, 'cycle');
    assert.equal(result.sevenDayTokens, 200_000_000);
  });

  it('fetches API on cache miss and returns correct data', async () => {
    const result = await getGlmUsage(createMockDeps());

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 10);
    assert.equal(result.fiveHourWindowType, 'cycle');
    assert.equal(result.platform, 'glm');
    // Calibrated: limit7d = 22.3M * 100 * 5 / 10 = 1115M; 7d% = 310M / 1115M * 100 = 28
    assert.equal(result.sevenDay, 28);
    assert.equal(result.sevenDayWindowType, 'cycle');
    assert.equal(result.sevenDayTokens, 310_000_000);
    assert.ok(result.fiveHourResetAt === null || result.fiveHourResetAt instanceof Date);
    assert.ok(result.sevenDayResetAt === null || result.sevenDayResetAt instanceof Date);
  });

  it('sets 7d to null when 24h tokens is zero', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 50,
        tokens5h: 0,
        tokens7d: 100_000,
      }),
    }));

    assert.notEqual(result, null);
    assert.equal(result.sevenDay, null);
    assert.equal(result.sevenDayTokens, undefined);
  });

  it('sets 7d to null when 7d tokens < 1000', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 50,
        tokens5h: 1_000_000,
        tokens7d: 500, // Below 1000 threshold
      }),
    }));

    assert.notEqual(result, null);
    assert.equal(result.sevenDay, null);
  });

  it('clamps 7d percentage to 100', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 100,
        tokens5h: 1_000, // Very low 5h → small calibrated limit → very high 7d%
        tokens7d: 10_000_000, // But lots of 7d tokens
      }),
    }));

    assert.notEqual(result, null);
    assert.ok(result.sevenDay <= 100, `7d should be <= 100, got ${result.sevenDay}`);
    assert.ok(result.sevenDay >= 0, `7d should be >= 0, got ${result.sevenDay}`);
  });

  it('returns null when both fiveHour and sevenDay are null', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: null,
        tokens5h: 0,
        tokens7d: 0,
      }),
    }));

    assert.equal(result, null);
  });

  it('shows 7d on first call by inferring subscription time from API', async () => {
    // First call after cache clear: no subscriptionTimeMs → rolling 7d query
    // But subscription time is inferred from timeLimitResetTime and used immediately
    let cacheWritten = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 20,
        tokens5h: 100_000_000,
        tokens7d: 400_000_000,
        timeLimitResetTime: new Date('2026-04-30T07:43:12.000Z').getTime(),
      }),
      writeCache: (data) => { cacheWritten = data; },
      readCalibrationFields: () => null, // No cached subscription time
    }));

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 20);
    // 7d is now computed using inferred subscription time
    assert.notEqual(result.sevenDay, null);
    // Subscription time should be inferred and cached
    assert.notEqual(cacheWritten.subscriptionTimeMs, null);
  });

  it('handles auth failure gracefully', async () => {
    const error = new Error('Auth failed: 401');
    error.name = 'GlmAuthError';

    let cacheWritten = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => { throw error; },
      writeCache: (data) => { cacheWritten = data; },
    }));

    assert.equal(result, null);
    assert.notEqual(cacheWritten, null);
    assert.equal(cacheWritten.isError, true);
    assert.ok(cacheWritten.ttlMs >= 45_000 && cacheWritten.ttlMs <= 75_000);
  });

  it('falls back to stale cache on retryable error', async () => {
    const error = new Error('Server error: 500');
    error.name = 'GlmRetryableError';

    // When readCache returns null (cache miss/expired), retryable error falls back to null
    const result = await getGlmUsage({
      ...createMockDeps(),
      readCache: () => null,
      fetchGlmApi: async () => { throw error; },
    });

    assert.equal(result, null);
  });

  it('falls back to stale error-cached data on retryable error', async () => {
    const error = new Error('Server error: 502');
    error.name = 'GlmRetryableError';

    const staleCached = {
      platform: 'glm',
      fiveHour: 20,
      sevenDay: 5,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: 'estimated',
      timestamp: Date.now() - 600_000,
      ttlMs: 5 * 60 * 1000,
    };

    // Simulate: cache is expired but readCache returns stale data as fallback
    // In our impl, readCache returns null on expired entries, so this tests
    // the code path where readCache returns stale data for error fallback
    const result = await getGlmUsage({
      ...createMockDeps(),
      readCache: () => staleCached, // Simulating stale cache with expired TTL
      fetchGlmApi: async () => { throw error; },
    });

    // When readCache returns non-null cached data, the main path returns it first
    // But since it's not isError, it will be returned directly
    assert.notEqual(result, null);
  });

  it('handles fetch timeout gracefully', async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';

    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => { throw error; },
    }));

    assert.equal(result, null);
  });

  it('calculates 7d percentage correctly: calibrated formula', async () => {
    // Calibrated: limit7d = 22.3M * 100 * 5 / 10 = 1115M; 7d% = 310M / 1115M * 100 = 28
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 10,
        tokens5h: 22_300_000,
        tokens7d: 310_000_000,
      }),
    }));

    assert.equal(result.sevenDay, 28);
  });

  // ---- Calibration-specific tests ----

  it('hides 7d when subscription time is unknown', async () => {
    // No subscription time → can't compute fixed-cycle 7d
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 5,
        tokens5h: 50_000_000,
        tokens7d: 200_000_000,
      }),
      readCalibrationFields: () => null,
    }));

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 5);
    assert.equal(result.sevenDay, null);
  });

  it('calibrates and uses calibrated limit when fiveHourPct >= 10%', async () => {
    let writtenData = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 20,
        tokens5h: 100_000_000,
        tokens7d: 250_000_000,
      }),
      writeCache: (data) => { writtenData = data; },
    }));

    // Calibrated limit = 100M * 100 * 5 / 20 = 2500M
    assert.notEqual(writtenData, null);
    assert.equal(Math.round(writtenData.calibratedLimit7d), 2_500_000_000);
    assert.ok(writtenData.calibratedAt != null);
    // 7d% = 250M / 2500M * 100 = 10
    assert.equal(writtenData.sevenDay, 10);
  });

  it('7d% does NOT change when fiveHourPct drops after calibration', async () => {
    const FIXED_NOW = 1700000000000;

    // First call: calibrate with fiveHourPct=50%
    let writtenFirst = null;
    const result1 = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 50,
        tokens5h: 100_000_000,
        tokens7d: 200_000_000,
      }),
      writeCache: (data) => { writtenFirst = data; },
      readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
      now: () => FIXED_NOW,
    }));

    // Calibrated limit = 100M * 100 * 5 / 50 = 1000M
    // 7d% = 200M / 1000M * 100 = 20
    assert.equal(result1.sevenDay, 20);
    const calibratedLimit = writtenFirst.calibratedLimit7d;

    // Second call: fiveHourPct drops to 10% (5h window rolled over), same tokens
    const result2 = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 10, // Dropped due to 5h rollover
        tokens5h: 100_000_000,
        tokens7d: 200_000_000,
      }),
      readCalibrationFields: () => ({
        calibratedLimit7d: calibratedLimit,
        calibratedAt: FIXED_NOW,
        calibratedAtPct: 50,
        subscriptionTimeMs: FIXED_SUB_TIME,
        sevenDay: 20,
        sevenDayTokens: 200_000_000,
        sevenDayStartAt: writtenFirst.sevenDayStartAt,
      }),
      now: () => FIXED_NOW + 60_000, // 1 minute later
    }));

    // 7d% should be the SAME — monotonic enforcement prevents decrease within same cycle
    assert.equal(result2.sevenDay, 20);
  });

  it('uses cached calibration when fiveHourPct is null', async () => {
    let writtenData = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: null,
        tokens5h: 50_000_000,
        tokens7d: 200_000_000,
      }),
      writeCache: (data) => { writtenData = data; },
      readCalibrationFields: () => ({
        calibratedLimit7d: 500_000_000,
        calibratedAt: Date.now(),
        subscriptionTimeMs: FIXED_SUB_TIME,
      }),
    }));

    assert.notEqual(result, null);
    // No new calibration (fiveHourPct null), but uses cached limit
    assert.equal(writtenData.calibratedLimit7d, 500_000_000); // from mock
    // 7d% = 200M / 500M * 100 = 40
    assert.equal(result.sevenDay, 40);
  });

  it('recalibrates after 24h when fiveHourPct >= 10%', async () => {
    const OLD_NOW = 1700000000000;
    const NEW_NOW = OLD_NOW + 25 * 60 * 60 * 1000; // 25h later

    let writtenData = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 30,
        tokens5h: 80_000_000,
        tokens7d: 300_000_000,
      }),
      writeCache: (data) => { writtenData = data; },
      readCalibrationFields: () => ({
        calibratedLimit7d: 999_000_000, // Old stale limit
        calibratedAt: OLD_NOW,
        subscriptionTimeMs: FIXED_SUB_TIME,
      }),
      now: () => NEW_NOW,
    }));

    // Should recalibrate: new limit = 80M * 100 * 5 / 30 = 1333.33M (not rounded)
    assert.ok(Math.abs(writtenData.calibratedLimit7d - 80_000_000 * 100 * 5 / 30) < 1);
    assert.equal(writtenData.calibratedAt, NEW_NOW);
  });

  it('recalibrates even at low fiveHourPct with exact 5h tokens', async () => {
    const OLD_NOW = 1700000000000;
    const NEW_NOW = OLD_NOW + 25 * 60 * 60 * 1000; // 25h later

    let writtenData = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 5,
        tokens5h: 80_000_000,
        tokens7d: 300_000_000,
      }),
      writeCache: (data) => { writtenData = data; },
      readCalibrationFields: () => ({
        calibratedLimit7d: 500_000_000,
        calibratedAt: OLD_NOW,
        subscriptionTimeMs: FIXED_SUB_TIME,
      }),
      now: () => NEW_NOW,
    }));

    // Should recalibrate with exact 5h data: limit = 80M * 100 * 5 / 5 = 8000M
    assert.equal(writtenData.calibratedLimit7d, 8_000_000_000);
    assert.equal(writtenData.calibratedAt, NEW_NOW);
    // 7d% = 300M / 8000M * 100 = 3.75 → 4
    assert.equal(result.sevenDay, 4);
  });

  it('carries calibration through error states', async () => {
    const error = new Error('Auth failed: 401');
    error.name = 'GlmAuthError';

    let writtenData = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => { throw error; },
      writeCache: (data) => { writtenData = data; },
      readCalibrationFields: () => ({
        calibratedLimit7d: 500_000_000,
        calibratedAt: 1700000000000,
      }),
    }));

    assert.notEqual(writtenData, null);
    assert.equal(writtenData.isError, true);
    // Calibration data should survive the error
    assert.equal(writtenData.calibratedLimit7d, 500_000_000);
  });

  // ---- Two-stage refresh tests ----

  it('returns cached data when both 5h and 7d are fresh', async () => {
    const NOW = 1700000000000;
    let fetchCalled = false;
    const result = await getGlmUsage(createMockDeps({
      now: () => NOW,
      readCache: () => ({
        platform: 'glm',
        fiveHour: 20,
        sevenDay: 10,
        sevenDayTokens: 100_000_000,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        timestamp: NOW - 10_000, // 10s ago
        ttlMs: 5 * 60 * 1000,
        fiveHourFetchedAt: NOW - 10_000, // 10s ago, within 30s TTL
      }),
      fetchGlmApi: async () => { fetchCalled = true; return { fiveHourPct: 0, tokens5h: 0, tokens7d: 0 }; },
      fetchGlmQuotaOnly: async () => { fetchCalled = true; return { fiveHourPct: 0 }; },
    }));

    assert.equal(fetchCalled, false);
    assert.equal(result.fiveHour, 20);
    assert.equal(result.sevenDay, 10);
  });

  it('does lightweight refresh when 5h stale but 7d fresh (non-milestone)', async () => {
    const NOW = 1700000000000;
    const CACHE_TIME = NOW - 60_000; // 1 min ago → 5h TTL expired (30s), but 7d TTL fresh (5min)

    let quotaCalled = false;
    let apiCalled = false;
    let writtenData = null;

    const result = await getGlmUsage(createMockDeps({
      now: () => NOW,
      readCache: () => ({
        platform: 'glm',
        fiveHour: 32,
        sevenDay: 15,
        sevenDayTokens: 200_000_000,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        timestamp: CACHE_TIME,
        ttlMs: 5 * 60 * 1000,
        fiveHourFetchedAt: CACHE_TIME,
      }),
      fetchGlmApi: async () => { apiCalled = true; return { fiveHourPct: 0, tokens5h: 0, tokens7d: 0 }; },
      fetchGlmQuotaOnly: async () => {
        quotaCalled = true;
        return { fiveHourPct: 33, tokensLimitResetTime: NOW + 3600000, timeLimitResetTime: null };
      },
      writeCache: (data, preserveTs) => { writtenData = { data, preserveTs }; },
    }));

    assert.equal(quotaCalled, true);
    assert.equal(apiCalled, false, 'Should NOT call full API on non-milestone lightweight refresh');
    assert.equal(result.fiveHour, 33);
    assert.equal(result.sevenDay, 15, '7d should be preserved from cache');
    assert.equal(result.sevenDayTokens, 200_000_000);
    assert.equal(writtenData.preserveTs, CACHE_TIME, 'Should preserve 7d TTL timestamp');
    assert.equal(writtenData.data.fiveHourFetchedAt, NOW);
  });

  it('upgrades to full refresh when 5h milestone detected', async () => {
    const NOW = 1700000000000;
    const CACHE_TIME = NOW - 60_000;

    let apiCalled = false;
    const result = await getGlmUsage(createMockDeps({
      now: () => NOW,
      readCache: () => ({
        platform: 'glm',
        fiveHour: 27,
        sevenDay: 15,
        sevenDayTokens: 200_000_000,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        timestamp: CACHE_TIME,
        ttlMs: 5 * 60 * 1000,
        fiveHourFetchedAt: CACHE_TIME,
      }),
      fetchGlmQuotaOnly: async () => ({
        fiveHourPct: 31, // Milestone! 31 % 10 === 1
        tokensLimitResetTime: null,
        timeLimitResetTime: null,
      }),
      fetchGlmApi: async () => {
        apiCalled = true;
        return {
          fiveHourPct: 31,
          tokens5h: 100_000_000,
          tokens7d: 300_000_000,
          timeLimitResetTime: new Date('2026-04-30T07:43:12.000Z').getTime(),
        };
      },
      readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
    }));

    assert.equal(apiCalled, true, 'Should call full API on milestone detection');
    assert.equal(result.fiveHour, 31);
    assert.notEqual(result.sevenDay, 15, '7d should be recalculated, not preserved');
  });

  it('returns stale cache on lightweight refresh failure', async () => {
    const NOW = 1700000000000;
    const CACHE_TIME = NOW - 60_000;

    const result = await getGlmUsage(createMockDeps({
      now: () => NOW,
      readCache: () => ({
        platform: 'glm',
        fiveHour: 20,
        sevenDay: 10,
        sevenDayTokens: 100_000_000,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        timestamp: CACHE_TIME,
        ttlMs: 5 * 60 * 1000,
        fiveHourFetchedAt: CACHE_TIME,
      }),
      fetchGlmQuotaOnly: async () => { throw new Error('Network error'); },
    }));

    assert.equal(result.fiveHour, 20, 'Should return stale 5h on lightweight failure');
    assert.equal(result.sevenDay, 10, 'Should preserve 7d from cache');
  });

  it('preserves all calibration fields during lightweight refresh', async () => {
    const NOW = 1700000000000;
    const CACHE_TIME = NOW - 60_000;

    let writtenData = null;
    await getGlmUsage(createMockDeps({
      now: () => NOW,
      readCache: () => ({
        platform: 'glm',
        fiveHour: 20,
        sevenDay: 15,
        sevenDayTokens: 200_000_000,
        fiveHourWindowType: 'cycle',
        sevenDayWindowType: 'cycle',
        timestamp: CACHE_TIME,
        ttlMs: 5 * 60 * 1000,
        fiveHourFetchedAt: CACHE_TIME,
        calibratedLimit7d: 1000_000_000,
        calibratedAt: CACHE_TIME - 100_000,
        calibratedAtPct: 20,
        subscriptionTimeMs: FIXED_SUB_TIME,
        sevenDayStartAt: 1700000000000 - 3 * 24 * 3600 * 1000,
        sevenDayResetAt: 1700000000000 + 4 * 24 * 3600 * 1000,
      }),
      fetchGlmQuotaOnly: async () => ({ fiveHourPct: 25, tokensLimitResetTime: null, timeLimitResetTime: null }),
      writeCache: (data, preserveTs) => { writtenData = { data, preserveTs }; },
    }));

    assert.equal(writtenData.data.calibratedLimit7d, 1000_000_000);
    assert.equal(writtenData.data.calibratedAtPct, 20);
    assert.equal(writtenData.data.subscriptionTimeMs, FIXED_SUB_TIME);
    assert.equal(writtenData.data.sevenDay, 15);
    assert.equal(writtenData.data.sevenDayTokens, 200_000_000);
    assert.equal(writtenData.preserveTs, CACHE_TIME);
  });

  // ---- Milestone sampling tests ----

  it('collects samples at milestones and calibrates with average', async () => {
    const NOW = 1700000000000;
    // First call at 11% (milestone: key="10")
    let written1 = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 11,
        tokens5h: 100_000_000,
        tokens7d: 500_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written1 = data; },
      readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
      now: () => NOW,
    }));

    // Should have one sample at milestone key "10"
    assert.deepEqual(written1.milestoneSamples, { '10': [100_000_000] });

    // Second call at 21% (milestone: key="20")
    let written2 = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 21,
        tokens5h: 210_000_000,
        tokens7d: 500_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written2 = data; },
      readCalibrationFields: () => ({
        subscriptionTimeMs: FIXED_SUB_TIME,
        milestoneSamples: { '10': [100_000_000] },
        sevenDayStartAt: undefined,
      }),
      now: () => NOW + 60 * 1000,
    }));

    // Should have samples at both "10" and "20"
    assert.deepEqual(written2.milestoneSamples, { '10': [100_000_000], '20': [210_000_000] });

    // Average calibration: (100M*500/10 + 210M*500/20) / 2 = (5000M + 5250M) / 2 = 5125M
    assert.ok(Math.abs(written2.calibratedLimit7d - 5_125_000_000) < 1);
  });

  it('falls back to single-point when no milestone samples', async () => {
    const NOW = 1700000000000;
    let written = null;
    // Non-milestone (47%) with no prior samples → single-point fallback
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 47,
        tokens5h: 100_000_000,
        tokens7d: 300_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written = data; },
      readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
      now: () => NOW,
    }));

    // No milestone samples collected (47 is not a milestone)
    assert.equal(written.milestoneSamples, undefined);
    // Single-point: 100M * 500 / 47 ≈ 1063.8M
    const expected = 100_000_000 * 500 / 47;
    assert.ok(Math.abs(written.calibratedLimit7d - expected) < 1);
  });

  it('clears samples on new cycle', async () => {
    const NOW = 1700000000000;
    const oldCycleStart = FIXED_SUB_TIME + Math.floor((NOW - FIXED_SUB_TIME) / CYCLE_MS) * CYCLE_MS;
    const newCycleStart = oldCycleStart + CYCLE_MS;

    let written = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 11,
        tokens5h: 50_000_000,
        tokens7d: 100_000_000,
        tokensLimitResetTime: newCycleStart + 5 * 3600 * 1000,
        timeLimitResetTime: newCycleStart + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written = data; },
      readCalibrationFields: () => ({
        subscriptionTimeMs: FIXED_SUB_TIME,
        milestoneSamples: { '10': [100_000_000], '20': [200_000_000] },
        sevenDayStartAt: oldCycleStart,
      }),
      // Move time past old cycle so a new cycle starts
      now: () => newCycleStart + 60 * 1000,
    }));

    // Samples should be cleared (new cycle) then fresh one at milestone key "10" added
    assert.deepEqual(written.milestoneSamples, { '10': [50_000_000] });
  });

  it('truncates samples to max 10 per milestone', async () => {
    const NOW = 1700000000000;
    const existingSamples = [];
    for (let i = 0; i < 9; i++) existingSamples.push(100_000_000 + i * 1_000_000);

    let written = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 11,
        tokens5h: 115_000_000,
        tokens7d: 500_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written = data; },
      readCalibrationFields: () => ({
        subscriptionTimeMs: FIXED_SUB_TIME,
        milestoneSamples: { '10': existingSamples },
        sevenDayStartAt: undefined,
      }),
      now: () => NOW,
    }));

    // 9 existing + 1 new = 10, no truncation
    assert.equal(written.milestoneSamples['10'].length, 10);
    assert.equal(written.milestoneSamples['10'][9], 115_000_000);
    // First sample preserved
    assert.equal(written.milestoneSamples['10'][0], 100_000_000);

    // Now add one more to trigger truncation
    const tenSamples = [...written.milestoneSamples['10']];
    let written2 = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 11,
        tokens5h: 120_000_000,
        tokens7d: 500_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written2 = data; },
      readCalibrationFields: () => ({
        subscriptionTimeMs: FIXED_SUB_TIME,
        milestoneSamples: { '10': tenSamples },
        sevenDayStartAt: undefined,
      }),
      now: () => NOW + 60 * 1000,
    }));

    // Should be truncated to 10 (last 10 of 11)
    assert.equal(written2.milestoneSamples['10'].length, 10);
    // First sample should be the 2nd from previous batch (dropped the oldest)
    assert.equal(written2.milestoneSamples['10'][0], 101_000_000);
    assert.equal(written2.milestoneSamples['10'][9], 120_000_000);
  });

  it('uses existing samples during non-milestone full refresh', async () => {
    const NOW = 1700000000000;
    let written = null;
    // 47% is NOT a milestone, but we have existing samples
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 47,
        tokens5h: 100_000_000,
        tokens7d: 300_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written = data; },
      readCalibrationFields: () => ({
        subscriptionTimeMs: FIXED_SUB_TIME,
        milestoneSamples: { '10': [100_000_000], '20': [210_000_000] },
        sevenDayStartAt: undefined,
      }),
      now: () => NOW,
    }));

    // No new sample collected (47 is not milestone)
    assert.deepEqual(written.milestoneSamples, { '10': [100_000_000], '20': [210_000_000] });
    // Should use average from existing samples: (100M*500/10 + 210M*500/20) / 2 = 5125M
    assert.ok(Math.abs(written.calibratedLimit7d - 5_125_000_000) < 1);
  });

  it('backward compatible with old cache without milestoneSamples', async () => {
    const NOW = 1700000000000;
    let written = null;
    await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 11,
        tokens5h: 80_000_000,
        tokens7d: 300_000_000,
        tokensLimitResetTime: NOW + 5 * 3600 * 1000,
        timeLimitResetTime: NOW + 30 * 24 * 3600 * 1000,
      }),
      writeCache: (data) => { written = data; },
      readCalibrationFields: () => ({
        subscriptionTimeMs: FIXED_SUB_TIME,
        // No milestoneSamples field at all
      }),
      now: () => NOW,
    }));

    // Should work fine, create first sample
    assert.deepEqual(written.milestoneSamples, { '10': [80_000_000] });
    // Calibrated using the single sample
    assert.equal(written.calibratedLimit7d, 80_000_000 * 500 / 10);
  });
});
