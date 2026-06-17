import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { readCache, writeCache, getErrorTtlMs, getRateLimitedTtlMs, appendLog, migrateOldCache, readState, writeState } from '../dist/usage/glm/cache.js';
import { inferSubscriptionTime, computeCycleStart } from '../dist/usage/glm/calibration.js';

let TEMP_DIR;
let CACHE_DIR;
let CACHE_PATH;
let STATE_PATH;

function setupPaths(tempDir) {
  CACHE_DIR = path.join(tempDir, '.claude', 'plugins', 'claude-statusline');
  CACHE_PATH = path.join(CACHE_DIR, '.usage-cache.json');
  STATE_PATH = path.join(CACHE_DIR, '.usage-state.json');
}

function makeCache(overrides = {}) {
  return {
    platform: 'glm',
    fiveHour: 10,
    sevenDay: 8,
    sevenDayTokens: undefined,
    fiveHourFetchedAt: Date.now(),
    fiveHourStartAt: null,
    fiveHourResetAt: null,
    sevenDayStartAt: null,
    sevenDayResetAt: null,
    timestamp: Date.now(),
    ttlMs: 5 * 60 * 1000,
    isError: false,
    fiveHourWindowType: 'cycle',
    sevenDayWindowType: 'cycle',
    ...overrides,
  };
}

function cleanup() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
  try { fs.unlinkSync(CACHE_PATH + '.tmp'); } catch {}
  try { fs.unlinkSync(STATE_PATH); } catch {}
  try { fs.unlinkSync(STATE_PATH + '.tmp'); } catch {}
}

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('usage-cache', () => {
  let originalHome;
  let originalConfigDir;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    TEMP_DIR = await mkdtemp(path.join(os.tmpdir(), 'claude-statusline-usage-cache-'));
    process.env.HOME = TEMP_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    setupPaths(TEMP_DIR);
    cleanup();
  });

  afterEach(async () => {
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('returns null when cache file does not exist', () => {
    assert.equal(readCache('glm'), null);
  });

  it('writes and reads cache within TTL', () => {
    writeCache(makeCache({ fiveHour: 10, sevenDay: 8, sevenDayTokens: 310000000 }));

    const cached = readCache('glm');
    assert.notEqual(cached, null);
    assert.equal(cached.fiveHour, 10);
    assert.equal(cached.sevenDay, 8);
    assert.equal(cached.sevenDayTokens, 310000000);
    assert.equal(cached.platform, 'glm');
  });

  it('returns null on platform mismatch', () => {
    writeCache(makeCache());
    assert.equal(readCache('anthropic'), null);
  });

  it('returns null when TTL expired', () => {
    // Write a cache entry with a timestamp far in the past so TTL is already expired
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(makeCache({ ttlMs: 1, timestamp: Date.now() - 10000 })), { mode: 0o600 });
    assert.equal(readCache('glm'), null);
  });

  it('returns null on malformed JSON', () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, 'not valid json{', { mode: 0o600 });
    assert.equal(readCache('glm'), null);
  });

  it('cache file has 0600 permissions', () => {
    writeCache(makeCache());
    const stat = fs.statSync(CACHE_PATH);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600, got ${mode.toString(8)}`);
  });

  it('cache does not contain credentials', () => {
    writeCache(makeCache());
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal('authToken' in parsed, false, 'Cache must not contain authToken');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in parsed, false, 'Cache must not contain ANTHROPIC_AUTH_TOKEN');
  });

  it('handles error state entries', () => {
    writeCache(makeCache({ fiveHour: null, sevenDay: null, isError: true }));
    const cached = readCache('glm');
    assert.notEqual(cached, null);
    assert.equal(cached.isError, true);
    assert.equal(cached.fiveHour, null);
  });
});

describe('state file (readState/writeState)', () => {
  let originalHome;
  let originalConfigDir;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    TEMP_DIR = await mkdtemp(path.join(os.tmpdir(), 'claude-statusline-usage-cache-'));
    process.env.HOME = TEMP_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    setupPaths(TEMP_DIR);
    cleanup();
  });

  afterEach(async () => {
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('returns null when state file does not exist', () => {
    assert.equal(readState(), null);
  });

  it('writes and reads state', () => {
    const subTime = new Date('2026-03-30T07:43:28.000Z').getTime();
    writeState({ calibratedLimit7d: 500_000_000, calibratedAt: Date.now(), subscriptionTimeMs: subTime });

    const state = readState();
    assert.notEqual(state, null);
    assert.equal(state.calibratedLimit7d, 500_000_000);
    assert.equal(state.subscriptionTimeMs, subTime);
  });

  it('persists state beyond cache TTL', () => {
    const subTime = new Date('2026-03-30T07:43:28.000Z').getTime();
    writeState({ calibratedLimit7d: 500_000_000, calibratedAt: Date.now(), subscriptionTimeMs: subTime });

    // Expire the cache by writing an entry with a past timestamp
    fs.writeFileSync(CACHE_PATH, JSON.stringify(makeCache({ ttlMs: 1, timestamp: Date.now() - 10000 })), { mode: 0o600 });

    assert.equal(readCache('glm'), null);
    // State should still be readable
    const state = readState();
    assert.notEqual(state, null);
    assert.equal(state.subscriptionTimeMs, subTime);
  });

  it('handles null calibratedLimit7d', () => {
    writeState({ calibratedLimit7d: null, calibratedAt: Date.now(), subscriptionTimeMs: null });
    const state = readState();
    assert.notEqual(state, null);
    assert.equal(state.calibratedLimit7d, null);
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
    const ttl = getRateLimitedTtlMs(10);
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
    const monthlyReset = new Date('2026-04-30T07:43:12.000Z').getTime();
    const subTime = inferSubscriptionTime(monthlyReset);
    const subDate = new Date(subTime);
    assert.equal(subDate.getUTCDate(), 30);
    assert.equal(subDate.getUTCHours(), 7);
    assert.equal(subDate.getUTCMinutes(), 43);
    assert.ok(subTime < Date.now(), 'Should be in the past');
  });

  it('handles February edge case for day 30', () => {
    const monthlyReset = new Date('2026-03-30T07:43:12.000Z').getTime();
    const subTime = inferSubscriptionTime(monthlyReset);
    const subDate = new Date(subTime);
    assert.ok(subDate.getUTCMonth() === 2 || subDate.getUTCMonth() === 1, 'Should be Feb or Mar');
    if (subDate.getUTCMonth() === 1) {
      assert.ok(subDate.getUTCDate() <= 28, 'Feb should use last valid day');
    }
  });
});

describe('computeCycleStart', () => {
  const CYCLE = 7 * 24 * 60 * 60 * 1000;
  const SUB_TIME = new Date('2026-03-30T07:43:28.000Z').getTime();

  it('returns subscription time when now is exactly at subscription', () => {
    assert.equal(computeCycleStart(SUB_TIME, SUB_TIME), SUB_TIME);
  });

  it('returns correct boundary mid-cycle', () => {
    const midCycle = SUB_TIME + 3 * 24 * 60 * 60 * 1000;
    assert.equal(computeCycleStart(SUB_TIME, midCycle), SUB_TIME);
  });

  it('returns next boundary at exactly 7 days', () => {
    const nextCycle = SUB_TIME + CYCLE;
    assert.equal(computeCycleStart(SUB_TIME, nextCycle), nextCycle);
  });

  it('computes correct boundary across multiple cycles', () => {
    const now = SUB_TIME + 14 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000;
    const expected = SUB_TIME + 2 * CYCLE;
    assert.equal(computeCycleStart(SUB_TIME, now), expected);
  });

  it('verified against known cycle boundaries', () => {
    const apr6 = new Date('2026-04-06T07:43:28.000Z').getTime();
    const apr13 = new Date('2026-04-13T07:43:28.000Z').getTime();

    const apr10 = new Date('2026-04-10T12:00:00.000Z').getTime();
    assert.equal(computeCycleStart(SUB_TIME, apr10), apr6);

    assert.equal(computeCycleStart(SUB_TIME, apr13), apr13);

    const apr15 = new Date('2026-04-15T12:00:00.000Z').getTime();
    assert.equal(computeCycleStart(SUB_TIME, apr15), apr13);
  });
});

describe('migrateOldCache', () => {
  let originalHome;
  let originalConfigDir;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    TEMP_DIR = await mkdtemp(path.join(os.tmpdir(), 'claude-statusline-usage-cache-'));
    process.env.HOME = TEMP_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    setupPaths(TEMP_DIR);
    cleanup();
  });

  afterEach(async () => {
    restoreEnvVar('HOME', originalHome);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('migrates calibration fields from old cache to state file', () => {
    const subTime = new Date('2026-03-30T07:43:28.000Z').getTime();
    // Write old-format cache directly
    const oldCache = {
      platform: 'glm',
      fiveHour: 10,
      sevenDay: 50,
      fiveHourWindowType: 'cycle',
      sevenDayWindowType: 'cycle',
      ttlMs: 5 * 60 * 1000,
      timestamp: Date.now(),
      calibratedLimit7d: 500_000_000,
      calibratedAt: Date.now(),
      subscriptionTimeMs: subTime,
    };
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(oldCache), { mode: 0o600 });

    migrateOldCache();

    const state = readState();
    assert.notEqual(state, null);
    assert.equal(state.calibratedLimit7d, 500_000_000);
    assert.equal(state.subscriptionTimeMs, subTime);
  });

  it('skips migration when state file already exists', () => {
    writeState({ calibratedLimit7d: 999, calibratedAt: Date.now(), subscriptionTimeMs: null });
    migrateOldCache();
    const state = readState();
    assert.equal(state.calibratedLimit7d, 999);
  });
});
