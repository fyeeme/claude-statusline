import type { RenderContext } from '../types.js';
import { getTotalTokens } from '../stdin.js';

export function formatTokens(n: number): string {
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(0)}k`;
  }
  return n.toString();
}

export function formatContextValue(
  ctx: RenderContext,
  percent: number,
  mode: 'percent' | 'tokens' | 'remaining' | 'both',
): string {
  const totalTokens = getTotalTokens(ctx.stdin);
  const autoCompactWindow = ctx.config?.display?.autoCompactWindow ?? null;
  // When an explicit auto-compact window is configured, use it as the token
  // denominator so the tokens/both displays match the percentage (and /context),
  // rather than the full model context window.
  const size =
    typeof autoCompactWindow === 'number' && autoCompactWindow > 0
      ? autoCompactWindow
      : ctx.stdin.context_window?.context_window_size ?? 0;

  if (mode === 'tokens') {
    if (size > 0) {
      return `${formatTokens(totalTokens)}/${formatTokens(size)}`;
    }
    return formatTokens(totalTokens);
  }

  if (mode === 'both') {
    if (size > 0) {
      return `${percent}% (${formatTokens(totalTokens)}/${formatTokens(size)})`;
    }
    return `${percent}%`;
  }

  if (mode === 'remaining') {
    return `${Math.max(0, 100 - percent)}%`;
  }

  return `${percent}%`;
}
