import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readCache, writeCache, getErrorTtlMs, getRateLimitedTtlMs } from '../dist/usage-cache.js';

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
      sevenDayWindowType: 'estimated',
      ttlMs: 5 * 60 * 1000,
    });

    const cached = readCache('glm');
    assert.notEqual(cached, null);
    assert.equal(cached.fiveHour, 10);
    assert.equal(cached.sevenDay, 8);
    assert.equal(cached.sevenDayTokens, 310000000);
    assert.equal(cached.fiveHourWindowType, 'rolling');
    assert.equal(cached.sevenDayWindowType, 'estimated');
    assert.equal(cached.platform, 'glm');
  });

  it('returns null on platform mismatch', () => {
    writeCache({
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 8,
      fiveHourWindowType: 'rolling',
      sevenDayWindowType: 'estimated',
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
      sevenDayWindowType: 'estimated',
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
      sevenDayWindowType: 'estimated',
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
      sevenDayWindowType: 'estimated',
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
      sevenDayWindowType: 'estimated',
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
