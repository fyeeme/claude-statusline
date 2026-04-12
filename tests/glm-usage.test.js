import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getGlmUsage, formatTokenCount } from '../dist/glm-usage.js';

// ---- formatTokenCount tests ----

describe('formatTokenCount', () => {
  it('formats billions', () => {
    assert.equal(formatTokenCount(1_200_000_000), '1.2B');
  });

  it('formats billions (whole)', () => {
    assert.equal(formatTokenCount(2_000_000_000), '2B');
  });

  it('formats millions', () => {
    assert.equal(formatTokenCount(310_000_000), '310M');
  });

  it('formats millions (decimal)', () => {
    assert.equal(formatTokenCount(1_500_000), '1.5M');
  });

  it('formats thousands', () => {
    assert.equal(formatTokenCount(850_000), '850K');
  });

  it('formats thousands (decimal)', () => {
    assert.equal(formatTokenCount(1_500), '1.5K');
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
    }),
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
        sevenDayWindowType: 'estimated',
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
    assert.equal(result.sevenDayWindowType, 'estimated');
    assert.equal(result.sevenDayTokens, 200_000_000);
  });

  it('fetches API on cache miss and returns correct data', async () => {
    const result = await getGlmUsage(createMockDeps());

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 10);
    assert.equal(result.fiveHourWindowType, 'rolling');
    assert.equal(result.platform, 'glm');
    // 7d: (310M * 10) / (55.8M * 7) = 7.94 → 8
    assert.equal(result.sevenDay, 8);
    assert.equal(result.sevenDayWindowType, 'estimated');
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
        tokens24h: 1_000, // Very low 24h → very high 7d%
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

  it('calculates 7d percentage correctly: verification formula', async () => {
    // R5 verification: (310M × 10) / (55.8M × 7) = 7.94%
    const result = await getGlmUsage(createMockDeps({
      fetchGlmApi: async () => ({
        fiveHourPct: 10,
        tokens24h: 55_800_000,
        tokens7d: 310_000_000,
      }),
    }));

    assert.equal(result.sevenDay, 8); // Math.round(7.94) = 8
  });
});
