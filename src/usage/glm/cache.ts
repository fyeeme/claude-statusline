import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getHudPluginDir } from '../../claude-config-dir.js';
import type { CalibrationState } from './types.js';

const STATE_FILENAME = '.usage-state.json';

/** Ensure and return plugin directory. */
function getCacheDir(): string {
  const pluginDir = getHudPluginDir(os.homedir());
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }
  return pluginDir;
}

/** Path to .usage-state.json */
function getStatePath(): string {
  return path.join(getCacheDir(), STATE_FILENAME);
}

// --- State file (persistent calibration, no TTL) ---

/** Read .usage-state.json. Returns null on missing/invalid file. No TTL check. */
export function readState(): CalibrationState | null {
  const statePath = getStatePath();
  try {
    if (!fs.existsSync(statePath)) return null;
    const raw = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as CalibrationState;
  } catch {
    return null;
  }
}

/** Atomic write to .usage-state.json. */
export function writeState(state: CalibrationState): void {
  const statePath = getStatePath();
  try {
    getCacheDir();

    const tmpPath = statePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, statePath);

    try { fs.chmodSync(statePath, 0o600); } catch { /* best-effort */ }
  } catch {
    // State write failure is non-blocking
  }
}
