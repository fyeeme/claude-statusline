import { detectPlatform } from '../glm-detect.js';
import { getGlmUsage } from './glm/index.js';
import { getDeepSeekUsage } from './deepseek/index.js';
import { getUsageFromStdin } from './claude/index.js';
import type { StdinData, UsageData } from '../types.js';
import type { GlmUsageDeps } from './glm/index.js';
import type { DeepSeekUsageDeps } from './deepseek/index.js';

export type { GlmUsageDeps } from './glm/index.js';
export type { DeepSeekUsageDeps } from './deepseek/index.js';
export { getUsageFromStdin } from './claude/index.js';

export type UsageStrategyDeps = {
  /** GLM-specific dependency overrides (for testing) */
  glm?: Partial<GlmUsageDeps>;
  /** DeepSeek-specific dependency overrides (for testing) */
  deepseek?: Partial<DeepSeekUsageDeps>;
};

/**
 * Platform-aware usage strategy.
 *
 * Detects the subscription platform from ANTHROPIC_BASE_URL and routes:
 * - 'anthropic' → extract rate_limits from Claude Code's stdin JSON
 * - 'glm'       → fetch from GLM API with EMA calibration
 *
 * Returns null when usage data is unavailable.
 */
export async function getUsage(
  stdin: StdinData | null,
  deps: UsageStrategyDeps = {},
): Promise<UsageData | null> {
  const platform = detectPlatform();

  if (platform === 'anthropic') {
    if (!stdin) return null;
    return getUsageFromStdin(stdin);
  }

  if (platform === 'deepseek') {
    return getDeepSeekUsage(stdin, deps.deepseek);
  }

  // platform === 'glm'
  return getGlmUsage(deps.glm);
}
