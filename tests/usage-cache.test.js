import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { readState, writeState } from '../dist/usage/glm/cache.js';
import { inferSubscriptionTime, computeCycleStart } from '../dist/usage/glm/calibration.js';

let TEMP_DIR;
let CACHE_DIR;
let STATE_PATH;

function setupPaths(tempDir) {
  CACHE_DIR = path.join(tempDir, '.claude', 'plugins', 'claude-statusline');
  STATE_PATH = path.join(CACHE_DIR, '.usage-state.json');
}

function cleanup() {
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

  it('handles null calibratedLimit7d', () => {
    writeState({ calibratedLimit7d: null, calibratedAt: Date.now(), subscriptionTimeMs: null });
    const state = readState();
    assert.notEqual(state, null);
    assert.equal(state.calibratedLimit7d, null);
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
