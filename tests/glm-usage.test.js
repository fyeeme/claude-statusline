import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlmUsage } from '../dist/usage/glm/index.js';
import { formatTokenCount } from '../dist/usage/glm/api.js';

const NOW = 1_700_000_000_000;

// ---- Helpers ----

function createMockDeps(overrides = {}) {
  return {
    detectPlatform: () => 'glm',
    getGlmBaseDomain: () => 'https://api.z.ai',
    fetchFull: async () => ({ fiveHourPct: 25, tokens5h: 50_000_000, tokens7d: 100_000_000, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: 40, weeklyResetTime: NOW + 86400000 }),
    getGlmHeaders: () => ({ 'Authorization': 'test-token', 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' }),
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

  it('returns null when no base domain', async () => {
    const result = await getGlmUsage(createMockDeps({
      getGlmBaseDomain: () => null,
    }));
    assert.equal(result, null);
  });

  it('returns null when no auth token', async () => {
    const result = await getGlmUsage(createMockDeps({
      getGlmHeaders: () => null,
    }));
    assert.equal(result, null);
  });

  it('uses API weeklyPct directly on full refresh (no EMA)', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchFull: async () => ({ fiveHourPct: 20, tokens5h: 100_000_000, tokens7d: 250_000_000, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: 76, weeklyResetTime: NOW + 86400000 }),
    }));

    assert.notEqual(result, null);
    assert.equal(result.fiveHour, 20);
    assert.equal(result.sevenDay, 76); // weeklyPct direct, no EMA
    assert.equal(result.sevenDayTokens, 250_000_000);
    assert.equal(result.platform, 'glm');
  });

  it('returns null on auth error', async () => {
    const error = new Error('Auth failed: 401');
    error.name = 'GlmAuthError';

    const result = await getGlmUsage(createMockDeps({
      fetchFull: async () => { throw error; },
    }));

    assert.equal(result, null);
  });

  it('returns null on retryable error', async () => {
    const error = new Error('Server error: 502');
    error.name = 'GlmRetryableError';

    const result = await getGlmUsage(createMockDeps({
      fetchFull: async () => { throw error; },
    }));

    assert.equal(result, null);
  });

  it('returns null when both fiveHour and weeklyPct are null', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchFull: async () => ({ fiveHourPct: null, tokens5h: 0, tokens7d: 0, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: null, weeklyResetTime: null }),
    }));

    assert.equal(result, null);
  });

  it('clamps weeklyPct to [0, 100] range', async () => {
    const result = await getGlmUsage(createMockDeps({
      fetchFull: async () => ({ fiveHourPct: 100, tokens5h: 1_000, tokens7d: 10_000_000, tokensLimitResetTime: null, timeLimitResetTime: null, weeklyPct: 100, weeklyResetTime: NOW + 86400000 }),
    }));

    assert.notEqual(result, null);
    assert.ok(result.sevenDay <= 100, `Expected <= 100, got ${result.sevenDay}`);
    assert.ok(result.sevenDay >= 0, `Expected >= 0, got ${result.sevenDay}`);
  });
});
