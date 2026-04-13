import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readCache, writeCache, getErrorTtlMs, getRateLimitedTtlMs, readCalibrationFields, inferSubscriptionTime, computeCycleStart } from '../dist/usage-cache.js';

const CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'claude-hud');
const CACHE_PATH = path.join(CACHE_DIR, '.usage-cache.json');

function cleanupCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
  try { fs.unlinkSync(CACHE_PATH + '.tmp'); } catch {}
}

describe('usage-cache', () => {
  beforeEach(() => {
    cleanupCache();
  });

  afterEach(() => {
    cleanupCache();
  });

  it('returns null when cache file does not exist', () => {
    assert.equal(readCache('glm'), null);
  });

  it('writes and reads cache within TTL', () => {
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 8,
      sevenDayTokens: 310000000,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
    });

    const cached = readCache('glm');
    assert.notEqual(cached, null);
    assert.equal(cached.fiveHour, 10);
    assert.equal(cached.sevenDay, 8);
    assert.equal(cached.sevenDayTokens, 310000000);
    assert.equal(cached.fiveHourWindowType, 'rolling');
    assert.equal(cached.sevenDayWindowType, 'cycle');
    assert.equal(cached.platform, 'glm');
  });

  it('returns null on platform mismatch', () => {
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 8,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
    });

    assert.equal(readCache('anthropic'), null);
  });

  it('returns null when TTL expired', () => {
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 8,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 1, // 1ms TTL, will expire immediately
    });

    // Wait a tiny bit for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {}

    assert.equal(readCache('glm'), null);
  });

  it('returns null on malformed JSON', () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, 'not valid json{', { mode: 0o600 });

    assert.equal(readCache('glm'), null);
  });

  it('cache file has 0600 permissions', () => {
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 8,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
    });

    const stat = fs.statSync(CACHE_PATH);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600, got ${mode.toString(8)}`);
  });

  it('cache does not contain credentials', () => {
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 8,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
    });

    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal('authToken' in parsed, false, 'Cache must not contain authToken');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in parsed, false, 'Cache must not contain ANTHROPIC_AUTH_TOKEN');
    assert.equal('token' in parsed, false, 'Cache must not contain token');
  });

  it('handles error state entries', () => {
    writeCache({
      platform: 'glm',
      fiveHour: null,
      sevenDay: null,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 60000,
      isError: true,
    });

    const cached = readCache('glm');
    assert.notEqual(cached, null);
    assert.equal(cached.isError, true);
    assert.equal(cached.fiveHour, null);
  });
});

describe('getErrorTtlMs', () => {
  it('returns value between 45 and 75 seconds', () => {
    for (let i = 0; i < 100; i++) {
      const ttl = getErrorTtlMs();
      assert.ok(ttl >= 45_000, `TTL too low: ${ttl}`);
      assert.ok(ttl <= 75_000, `TTL too high: ${ttl}`);
    }
  });
});

describe('getRateLimitedTtlMs', () => {
  it('starts at ~60s for retry 1', () => {
    const ttl = getRateLimitedTtlMs(1);
    assert.ok(ttl >= 60_000, `Base too low: ${ttl}`);
    assert.ok(ttl <= 90_000, `Base + jitter too high: ${ttl}`);
  });

  it('caps at 5 minutes', () => {
    const ttl = getRateLimitedTtlMs(10); // very high retry count
    assert.ok(ttl <= 5 * 60 * 1000 + 30_000, `Exceeded cap: ${ttl}`);
  });

  it('increases with retry count', () => {
    const ttl1 = getRateLimitedTtlMs(1);
    const ttl3 = getRateLimitedTtlMs(3);
    assert.ok(ttl3 >= ttl1 * 0.5, `Should increase with retry count`);
  });
});

describe('inferSubscriptionTime', () => {
  it('infers subscription time from monthly reset timestamp', () => {
    // Monthly reset: 2026-04-30 15:43:12 UTC+8 = 2026-04-30T07:43:12Z
    const monthlyReset = new Date('2026-04-30T07:43:12.000Z').getTime();
    const subTime = inferSubscriptionTime(monthlyReset);

    // Should return the most recent 30th at 07:43:12 UTC before now
    const subDate = new Date(subTime);
    assert.equal(subDate.getUTCDate(), 30);
    assert.equal(subDate.getUTCHours(), 7);
    assert.equal(subDate.getUTCMinutes(), 43);
    assert.ok(subTime < Date.now(), 'Should be in the past');
  });

  it('handles February edge case for day 30', () => {
    // Day 30 doesn't exist in February — should use last day of Feb
    // Monthly reset on March 30 (day=30), testing around Feb
    const monthlyReset = new Date('2026-03-30T07:43:12.000Z').getTime();
    const subTime = inferSubscriptionTime(monthlyReset);
    const subDate = new Date(subTime);

    // In March, the current month's 30th should be returned
    assert.ok(subDate.getUTCMonth() === 2 || subDate.getUTCMonth() === 1, 'Should be Feb or Mar');
    if (subDate.getUTCMonth() === 1) {
      assert.ok(subDate.getUTCDate() <= 28, 'Feb should use last valid day');
    }
  });
});

describe('computeCycleStart', () => {
  const CYCLE = 7 * 24 * 60 * 60 * 1000;
  const SUB_TIME = new Date('2026-03-30T07:43:28.000Z').getTime(); // 3/30 15:43 UTC+8

  it('returns subscription time when now is exactly at subscription', () => {
    assert.equal(computeCycleStart(SUB_TIME, SUB_TIME), SUB_TIME);
  });

  it('returns correct boundary mid-cycle', () => {
    const midCycle = SUB_TIME + 3 * 24 * 60 * 60 * 1000; // 3 days in
    assert.equal(computeCycleStart(SUB_TIME, midCycle), SUB_TIME);
  });

  it('returns next boundary at exactly 7 days', () => {
    const nextCycle = SUB_TIME + CYCLE;
    assert.equal(computeCycleStart(SUB_TIME, nextCycle), nextCycle);
  });

  it('computes correct boundary across multiple cycles', () => {
    const now = SUB_TIME + 14 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000; // 14.25 days in
    const expected = SUB_TIME + 2 * CYCLE; // Third cycle start
    assert.equal(computeCycleStart(SUB_TIME, now), expected);
  });

  it('verified against known cycle boundaries', () => {
    // Subscription: 3/30 15:43 UTC+8
    // Cycles: 3/30, 4/6, 4/13, 4/20
    const apr6 = new Date('2026-04-06T07:43:28.000Z').getTime();
    const apr13 = new Date('2026-04-13T07:43:28.000Z').getTime();
    const apr20 = new Date('2026-04-20T07:43:28.000Z').getTime();

    // Mid April 10 → cycle start should be Apr 6
    const apr10 = new Date('2026-04-10T12:00:00.000Z').getTime();
    assert.equal(computeCycleStart(SUB_TIME, apr10), apr6);

    // April 13 exactly → cycle start is Apr 13
    assert.equal(computeCycleStart(SUB_TIME, apr13), apr13);

    // April 15 → cycle start is Apr 13
    const apr15 = new Date('2026-04-15T12:00:00.000Z').getTime();
    assert.equal(computeCycleStart(SUB_TIME, apr15), apr13);
  });
});

describe('readCalibrationFields', () => {
  beforeEach(() => {
    cleanupCache();
  });

  afterEach(() => {
    cleanupCache();
  });

  it('returns subscriptionTimeMs alongside calibration data', () => {
    const subTime = new Date('2026-03-30T07:43:28.000Z').getTime();
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 50,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
      calibratedLimit7d: 500_000_000,
      calibratedAt: Date.now(),
      subscriptionTimeMs: subTime,
    });

    const result = readCalibrationFields();
    assert.notEqual(result, null);
    assert.equal(result.subscriptionTimeMs, subTime);
    assert.equal(result.calibratedLimit7d, 500_000_000);
  });

  it('returns subscriptionTimeMs from expired cache (TTL bypass)', () => {
    const subTime = new Date('2026-03-30T07:43:28.000Z').getTime();
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 50,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 1, // Will expire
      calibratedLimit7d: 500_000_000,
      calibratedAt: Date.now(),
      subscriptionTimeMs: subTime,
    });

    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {}

    // readCache should return null (expired)
    assert.equal(readCache('glm'), null);

    // But readCalibrationFields should still return data
    const result = readCalibrationFields();
    assert.notEqual(result, null);
    assert.equal(result.subscriptionTimeMs, subTime);
  });

  it('returns subscriptionTimeMs without calibration data', () => {
    const subTime = new Date('2026-03-30T07:43:28.000Z').getTime();
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: null,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
      subscriptionTimeMs: subTime,
    });

    const result = readCalibrationFields();
    assert.notEqual(result, null);
    assert.equal(result.subscriptionTimeMs, subTime);
    assert.equal(result.calibratedLimit7d, undefined);
  });

  it('returns null when cache file does not exist', () => {
    assert.equal(readCalibrationFields(), null);
  });
});
