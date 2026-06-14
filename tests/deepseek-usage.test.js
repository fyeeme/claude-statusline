import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeepSeekUsage, getProjectSessionsDir } from '../dist/usage/deepseek/index.js';
import { getWeekStartMs } from '../dist/usage/deepseek/api.js';
import { getUsage } from '../dist/usage/index.js';

const baseDeps = (overrides = {}) => ({
  getApiKey: () => 'sk-test',
  getOrigin: () => 'https://api.deepseek.com',
  readCache: () => null,
  writeCache: () => {},
  fetchBalance: async () => ({ totalBalance: '50.00', currency: 'CNY' }),
  scanWeeklyTokens: () => 1200000,
  now: () => 1000000,
  cacheTtlMs: 300000,
  ...overrides,
});

test('getDeepSeekUsage returns balance + weeklyTokens on successful fetch', async () => {
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps());
  assert.equal(result.platform, 'deepseek');
  assert.equal(result.balance, '50.00');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.weeklyTokens, 1200000);
  assert.equal(result.fiveHour, null);
  assert.equal(result.sevenDay, null);
});

test('getDeepSeekUsage returns cached entry within TTL without fetching', async () => {
  let fetched = false;
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps({
    readCache: () => ({ balance: '40.00', currency: 'CNY', weeklyTokens: 500000, fetchedAt: 900000, ttlMs: 300000 }),
    fetchBalance: async () => { fetched = true; return { totalBalance: '99', currency: 'CNY' }; },
  }));
  assert.equal(fetched, false, 'should not fetch within TTL');
  assert.equal(result.balance, '40.00');
});

test('getDeepSeekUsage returns partial data (weeklyTokens only) when no API key', async () => {
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps({
    getApiKey: () => null,
    fetchBalance: async () => null,
  }));
  assert.notEqual(result, null, 'should return weekly tokens even without key');
  assert.equal(result.balance, '?');
  assert.equal(result.weeklyTokens, 1200000);
});

test('getDeepSeekUsage returns partial data on balance API failure without cache', async () => {
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps({
    fetchBalance: async () => null,
    scanWeeklyTokens: () => 800000,
  }));
  assert.notEqual(result, null, 'should return weekly tokens on balance failure');
  assert.equal(result.balance, '?');
  assert.equal(result.weeklyTokens, 800000);
});

test('getDeepSeekUsage returns balance with weeklyTokens=0 when scan yields nothing', async () => {
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps({
    scanWeeklyTokens: () => 0,
  }));
  assert.equal(result.balance, '50.00');
  assert.equal(result.weeklyTokens, 0);
});

test('getDeepSeekUsage refreshes when cache expired', async () => {
  let fetched = false;
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps({
    readCache: () => ({ balance: '40.00', currency: 'CNY', weeklyTokens: 500, fetchedAt: 100000, ttlMs: 300000 }),
    fetchBalance: async () => { fetched = true; return { totalBalance: '60.00', currency: 'CNY' }; },
    scanWeeklyTokens: () => 800000,
  }));
  assert.equal(fetched, true, 'should fetch when cache stale');
  assert.equal(result.balance, '60.00');
});

test('getDeepSeekUsage falls back to stale cache on fetch failure', async () => {
  const result = await getDeepSeekUsage({ cwd: '/tmp/proj' }, baseDeps({
    readCache: () => ({ balance: '40.00', currency: 'CNY', weeklyTokens: 500, fetchedAt: 100000, ttlMs: 300000 }),
    fetchBalance: async () => null,
  }));
  assert.equal(result.balance, '40.00', 'should return stale cache on fetch failure');
});

test('getProjectSessionsDir converts cwd slashes to dashes', () => {
  const dir = getProjectSessionsDir('/Users/x/proj');
  assert.ok(dir.endsWith('-Users-x-proj'), `expected dash-encoded dir, got ${dir}`);
});

test('getProjectSessionsDir returns null for empty cwd', () => {
  assert.equal(getProjectSessionsDir(undefined), null);
  assert.equal(getProjectSessionsDir(''), null);
});

test('getWeekStartMs returns Monday 00:00 UTC', () => {
  // 2026-06-14 is a Sunday → week start is 2026-06-08 (Monday)
  const sunday = Date.UTC(2026, 5, 14, 12, 0, 0);
  const weekStart = getWeekStartMs(sunday);
  const monday = new Date(weekStart);
  assert.equal(monday.getUTCDay(), 1, 'should be Monday');
  assert.equal(monday.getUTCDate(), 8, 'should be June 8');
});

test('getUsage routes to deepseek provider when BASE_URL is deepseek', async () => {
  const savedUrl = process.env.ANTHROPIC_BASE_URL;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const result = await getUsage({ cwd: '/tmp/p' }, {
      deepseek: {
        fetchBalance: async () => ({ totalBalance: '50.00', currency: 'CNY' }),
        scanWeeklyTokens: () => 0,
        readCache: () => null,
        writeCache: () => {},
      },
    });
    assert.equal(result?.platform, 'deepseek');
    assert.equal(result?.balance, '50.00');
  } finally {
    if (savedUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});
