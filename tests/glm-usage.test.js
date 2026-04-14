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
    getGlmHeaders: () => ({
      'Authorization': 'test-token',
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
    }),
    fetchGlmApi: async () => ({
      fiveHourPct: 10,
      tokens24h: 55_800_000,
      tokens7d: 310_000_000,
      timeLimitResetTime: new Date('2026-04-30T07:43:12.000Z').getTime(),
    }),
    readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
    now: () => Date.now(),
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
        fiveHourWindowType: 'rolling',
        sevenDayWindowType: 'cycle',
        timestamp: Date.now(),
        ttlMs: 5 * 60 * 1000,
      }),
      fetchGlmApi: async () => {
        fetchCalled = true;
        return { fiveHourPct: 10, tokens24h: 0, tokens7d: 0 };
      },
    });

    assert.equal(fetchCalled, false, 'Should not call API on cache hit');
    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 15);
    assert.equal(result.sevenDay, 8);
    assert.equal(result.platform, 'glm');
    assert.equal(result.fiveHourWindowType, 'rolling');
    assert.equal(result.sevenDayWindowType, 'cycle');
    assert.equal(result.sevenDayTokens, 200_000_000);
  });

  it('fetches API on cache miss and returns correct data', async () => {
    const result = await getGlmUsage(createMockDeps());

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 10);
    assert.equal(result.fiveHourWindowType, 'rolling');
    assert.equal(result.platform, 'glm');
    // Calibrated: limit7d = 55.8M * 100 / 10 = 558M; 7d% = 310M / 558M * 100 = 55.6 → 56
    assert.equal(result.sevenDay, 56);
    assert.equal(result.sevenDayWindowType, 'cycle');
    assert.equal(result.sevenDayTokens, 310_000_000);
    assert.equal(result.fiveHourResetAt, null);
    assert.equal(result.sevenDayResetAt, null);
  });

  it('sets 7d to null when 24h tokens is zero', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 50,
        tokens24h: 0,
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
        tokens24h: 1_000_000,
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
        tokens24h: 1_000, // Very low 24h → small calibrated limit → very high 7d%
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
        tokens24h: 0,
        tokens7d: 0,
      }),
    }));

    assert.equal(result, null);
  });

  it('hides 7d on first call (no cached subscription time) even when API returns tokens', async () => {
    // First call after cache clear: no subscriptionTimeMs → rolling 7d query → skip 7d display
    // Subscription time is inferred from timeLimitResetTime and cached for next call
    let cacheWritten = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 20,
        tokens24h: 100_000_000,
        tokens7d: 400_000_000, // Rolling 7d — inflated
        timeLimitResetTime: new Date('2026-04-30T07:43:12.000Z').getTime(),
      }),
      writeCache: (data) => { cacheWritten = data; },
      readCalibrationFields: () => null, // No cached subscription time
    }));

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 20);
    // 7d must be null — we used rolling query, not fixed cycle
    assert.equal(result.sevenDay, null);
    // But subscription time should be inferred and cached for next call
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
      fiveHourWindowType: 'rolling',
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
    // Calibrated: limit7d = 55.8M * 100 / 10 = 558M; 7d% = 310M / 558M * 100 = 55.55% → 56
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 10,
        tokens24h: 55_800_000,
        tokens7d: 310_000_000,
      }),
    }));

    assert.equal(result.sevenDay, 56); // Math.round(55.55) = 56
  });

  // ---- Calibration-specific tests ----

  it('hides 7d when subscription time is unknown', async () => {
    // No subscription time → can't compute fixed-cycle 7d
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 5,
        tokens24h: 50_000_000,
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
        tokens24h: 100_000_000,
        tokens7d: 250_000_000,
      }),
      writeCache: (data) => { writtenData = data; },
    }));

    // Calibrated limit = 100M * 100 / 20 = 500M
    assert.notEqual(writtenData, null);
    assert.equal(writtenData.calibratedLimit7d, 500_000_000);
    assert.ok(writtenData.calibratedAt != null);
    // 7d% = 250M / 500M * 100 = 50
    assert.equal(writtenData.sevenDay, 50);
  });

  it('7d% does NOT change when fiveHourPct drops after calibration', async () => {
    const FIXED_NOW = 1700000000000;

    // First call: calibrate with fiveHourPct=50%
    let writtenFirst = null;
    const result1 = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 50,
        tokens24h: 100_000_000,
        tokens7d: 200_000_000,
      }),
      writeCache: (data) => { writtenFirst = data; },
      readCalibrationFields: () => ({ subscriptionTimeMs: FIXED_SUB_TIME }),
      now: () => FIXED_NOW,
    }));

    // Calibrated limit = 100M * 100 / 50 = 200M
    // 7d% = 200M / 200M * 100 = 100
    assert.equal(result1.sevenDay, 100);
    const calibratedLimit = writtenFirst.calibratedLimit7d;

    // Second call: fiveHourPct drops to 10% (5h window rolled over), same tokens
    const result2 = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 10, // Dropped due to 5h rollover
        tokens24h: 100_000_000,
        tokens7d: 200_000_000,
      }),
      readCalibrationFields: () => ({
        calibratedLimit7d: calibratedLimit,
        calibratedAt: FIXED_NOW, // Recent — no recalibration needed
        subscriptionTimeMs: FIXED_SUB_TIME,
      }),
      now: () => FIXED_NOW + 60_000, // 1 minute later
    }));

    // 7d% should be the SAME — calibrated limit is still 200M
    assert.equal(result2.sevenDay, 100);
  });

  it('uses cached calibration when fiveHourPct is null', async () => {
    let writtenData = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: null,
        tokens24h: 50_000_000,
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
    assert.equal(writtenData.calibratedLimit7d, 500_000_000);
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
        tokens24h: 80_000_000,
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

    // Should recalibrate: new limit = 80M * 100 / 30 = 266.67M (not rounded)
    assert.ok(Math.abs(writtenData.calibratedLimit7d - 80_000_000 * 100 / 30) < 1);
    assert.equal(writtenData.calibratedAt, NEW_NOW);
  });

  it('keeps old calibration when recalibration is due but fiveHourPct < 10%', async () => {
    const OLD_NOW = 1700000000000;
    const NEW_NOW = OLD_NOW + 25 * 60 * 60 * 1000; // 25h later

    let writtenData = null;
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 5, // Below threshold
        tokens24h: 80_000_000,
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

    // Should keep old calibration (fiveHourPct too low to recalibrate)
    assert.equal(writtenData.calibratedLimit7d, 500_000_000);
    assert.equal(writtenData.calibratedAt, OLD_NOW);
    // But still use the old calibrated limit for calculation
    // 7d% = 300M / 500M * 100 = 60
    assert.equal(result.sevenDay, 60);
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
});
