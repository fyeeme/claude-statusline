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
    const cacheTotal = tokens.cacheCreationTokens + tokens.cacheReadTokens;
    // Cache hit rate = cache reads / effective input (fresh input + cache hits).
    // cacheCreation is a one-off write cost, excluded so a warm cache does not
    // always read as 100%.
    const effectiveInput = tokens.inputTokens + tokens.cacheReadTokens;
    const hitRate = effectiveInput > 0 ? Math.round((tokens.cacheReadTokens / effectiveInput) * 100) : 0;
    parts.push(`${t('format.cache')}: ${formatTokens(cacheTotal)}, ${hitRate}%`);
  }

  return label(`${t('label.tokens')} ${formatTokens(total)} (${parts.join(', ')})`, colors);
}
