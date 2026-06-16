import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHudDisabled, main } from '../dist/index.js';
import { DEFAULT_CONFIG } from '../dist/config.js';

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test('isHudDisabled: any affirmative value disables the HUD', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ', '\ttrue']) {
    assert.equal(isHudDisabled({ CLAUDE_STATUSLINE_DISABLE: value }), true, `CLAUDE_STATUSLINE_DISABLE=${JSON.stringify(value)}`);
  }
});

test('isHudDisabled: unset, empty, or explicit negatives keep the HUD enabled', () => {
  for (const env of [{}, { CLAUDE_STATUSLINE_DISABLE: '' }, { CLAUDE_STATUSLINE_DISABLE: ' ' }, { CLAUDE_STATUSLINE_DISABLE: '0' }, { CLAUDE_STATUSLINE_DISABLE: 'false' }, { CLAUDE_STATUSLINE_DISABLE: 'OFF' }, { CLAUDE_STATUSLINE_DISABLE: 'no' }]) {
    assert.equal(isHudDisabled(env), false, `env=${JSON.stringify(env)}`);
  }
});

test('isHudDisabled: legacy CLAUDE_HUD_DISABLE name still honoured for backward compatibility', () => {
  // New name unset, legacy name set -> disabled
  assert.equal(isHudDisabled({ CLAUDE_HUD_DISABLE: '1' }), true);
  // New name takes precedence when both set
  assert.equal(isHudDisabled({ CLAUDE_HUD_DISABLE: '1', CLAUDE_STATUSLINE_DISABLE: '0' }), false);
});

test('main: CLAUDE_STATUSLINE_DISABLE=1 exits before reading stdin and prints nothing', async () => {
  const original = process.env.CLAUDE_STATUSLINE_DISABLE;
  process.env.CLAUDE_STATUSLINE_DISABLE = '1';
  const calls = [];
  try {
    await main({
      readStdin: async () => {
        calls.push('readStdin');
        return null;
      },
      log: (...args) => {
        calls.push(['log', ...args]);
      },
      render: () => {
        calls.push('render');
      },
    });
  } finally {
    restoreEnvVar('CLAUDE_STATUSLINE_DISABLE', original);
  }
  assert.deepEqual(calls, []);
});

test('main: explicit negative CLAUDE_STATUSLINE_DISABLE value still runs the HUD', async () => {
  const original = process.env.CLAUDE_STATUSLINE_DISABLE;
  process.env.CLAUDE_STATUSLINE_DISABLE = '0';
  const logged = [];
  try {
    await main({
      readStdin: async () => null,
      loadConfig: async () => DEFAULT_CONFIG,
      log: (...args) => {
        logged.push(args.join(' '));
      },
    });
  } finally {
    restoreEnvVar('CLAUDE_STATUSLINE_DISABLE', original);
  }
  assert.ok(logged.length > 0, 'expected the no-stdin setup message to be logged');
});
