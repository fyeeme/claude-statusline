import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DeepSeekBalance {
  totalBalance: string;
  currency: string;
}

/** Fetch account balance from DeepSeek API. Returns null on failure. */
export async function fetchBalance(
  origin: string,
  apiKey: string,
): Promise<DeepSeekBalance | null> {
  try {
    const res = await fetch(`${origin}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = data.balance_infos?.[0];
    if (!info) return null;
    return {
      totalBalance: info.total_balance ?? '?',
      currency: info.currency ?? 'CNY',
    };
  } catch {
    return null;
  }
}

/** Start of current natural week (Monday 00:00 UTC), in ms. */
export function getWeekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  const dayOfWeek = d.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset, 0, 0, 0, 0);
}

type SessionEntry = {
  type?: string;
  timestamp?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

/**
 * Scan a project's session JSONL files for this natural week's cumulative
 * assistant token usage. Claude Code stores sessions at
 * ~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl. Filters by entry
 * timestamp when present; counts an entry without a timestamp (best-effort).
 */
export function scanWeeklyTokens(projectDir: string, nowMs: number = Date.now()): number {
  const weekStart = getWeekStartMs(nowMs);
  let total = 0;

  let files: string[];
  try {
    files = readdirSync(projectDir);
  } catch {
    return 0;
  }

  for (const fname of files) {
    if (!fname.endsWith('.jsonl')) continue;
    let content: string;
    try {
      content = readFileSync(join(projectDir, fname), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: SessionEntry;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        continue;
      }
      if (entry.type !== 'assistant' || !entry.message?.usage) continue;
      // Filter by timestamp when present
      if (typeof entry.timestamp === 'string') {
        const ts = Date.parse(entry.timestamp);
        if (Number.isNaN(ts) || ts < weekStart) continue;
      }
      const u = entry.message.usage;
      total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
  }

  return total;
}

/** Read DeepSeek API key from env (Claude Code sets ANTHROPIC_API_KEY). */
export function getDeepSeekApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key || null;
}

/** Read DeepSeek API origin (protocol//host) from ANTHROPIC_BASE_URL. */
export function getDeepSeekOrigin(): string | null {
  const url = process.env.ANTHROPIC_BASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
