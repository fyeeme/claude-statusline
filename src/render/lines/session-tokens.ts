import type { RenderContext } from '../../types.js';
import { label } from '../colors.js';
import { t } from '../../i18n/index.js';

function formatTokens(n: number): string {
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(0)}k`;
  }
  return n.toString();
}

function calcCacheHitRate(inputTokens: number, cacheCreationTokens: number, cacheReadTokens: number): number | null {
  const totalInput = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (totalInput === 0 || cacheReadTokens === 0) {
    return null;
  }
  return Math.round((cacheReadTokens / totalInput) * 100);
}

export function renderSessionTokensLine(ctx: RenderContext): string | null {
  const display = ctx.config?.display;
  if (display?.showSessionTokens === false) {
    return null;
  }

  const tokens = ctx.transcript.sessionTokens;
  if (!tokens) {
    return null;
  }

  const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (total === 0) {
    return null;
  }

  const colors = ctx.config?.colors;
  const parts: string[] = [
    `${t('format.in')}: ${formatTokens(tokens.inputTokens)}`,
    `${t('format.out')}: ${formatTokens(tokens.outputTokens)}`,
  ];

  if (tokens.cacheCreationTokens > 0 || tokens.cacheReadTokens > 0) {
    parts.push(`${t('format.cache')}: ${formatTokens(tokens.cacheCreationTokens + tokens.cacheReadTokens)}`);
  }

  const cacheHitRate = calcCacheHitRate(tokens.inputTokens, tokens.cacheCreationTokens, tokens.cacheReadTokens);
  if (cacheHitRate !== null) {
    parts.push(`${t('format.cacheHit')}: ${cacheHitRate}%`);
  }

  return label(`Tokens ${formatTokens(total)} (${parts.join(', ')})`, colors);
}
