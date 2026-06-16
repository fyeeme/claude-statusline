import type { HudConfig } from './config.js';
import type { GitStatus } from './git.js';

export interface StdinData {
  transcript_path?: string;
  cwd?: string;
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    git_worktree?: string;
  } | null;
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    // Native percentage fields (Claude Code v2.1.6+)
    used_percentage?: number | null;
    remaining_percentage?: number | null;
  };
  cost?: {
    total_cost_usd?: number | null;
    total_duration_ms?: number | null;
    total_api_duration_ms?: number | null;
    total_lines_added?: number | null;
    total_lines_removed?: number | null;
  } | null;
  rate_limits?: {
    five_hour?: {
      used_percentage?: number | null;
      resets_at?: number | null;
    } | null;
    seven_day?: {
      used_percentage?: number | null;
      resets_at?: number | null;
    } | null;
  } | null;
  // Claude Code 2.1.115+ exposes effort as an object: { level: "max" }.
  // Earlier versions (≤2.1.114) did not send this field at all. The bare-string
  // shape is kept for backwards compatibility with the original PR #471 design
  // that future-proofed a string form before Anthropic had committed a schema.
  effort?: string | { level?: string | null; [key: string]: unknown } | null;
}

export interface ToolEntry {
  id: string;
  name: string;
  target?: string;
  status: 'running' | 'completed' | 'error';
  startTime: Date;
  endTime?: Date;
}

export interface AgentEntry {
  id: string;
  type: string;
  model?: string;
  description?: string;
  status: 'running' | 'completed';
  startTime: Date;
  endTime?: Date;
  background?: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Semantic window type for usage display */
export type UsageWindowType = 'fixed' | 'rolling' | 'cycle';

/** Platform that provides usage data */
export type UsagePlatform = 'anthropic' | 'glm' | 'deepseek';

export interface UsageData {
  fiveHour: number | null;  // 0-100 percentage, null if unavailable
  sevenDay: number | null;  // 0-100 percentage, null if unavailable
  fiveHourStartAt: Date | null;
  fiveHourResetAt: Date | null;
  sevenDayStartAt: Date | null;
  sevenDayResetAt: Date | null;
  /** Semantic window type for the 5h slot. Default: 'fixed' (Anthropic resets at a known time) */
  fiveHourWindowType?: UsageWindowType;
  /** Semantic window type for the 7d slot. Default: 'fixed' (Anthropic resets at a known time) */
  sevenDayWindowType?: UsageWindowType;
  /** Platform providing this usage data. Default: 'anthropic' */
  platform?: UsagePlatform;
  /** 7-day total token count (GLM only, for display context) */
  sevenDayTokens?: number;
  fiveHourTokens?: number;
  /** DeepSeek: account balance (absolute, e.g. "50.00") */
  balance?: string;
  /** DeepSeek: balance currency (e.g. "CNY") */
  currency?: string;
  /** DeepSeek: natural-week cumulative tokens (when no weekly quota limit) */
  weeklyTokens?: number;
  /** DeepSeek: estimated current-session cost in USD */
  sessionCostUsd?: number;
  balanceLabel?: string | null;  // optional raw balance text (e.g. "¥6.35")
}

export interface ExternalUsageSnapshot {
  five_hour?: {
    used_percentage?: number | null;
    resets_at?: string | number | null;
  } | null;
  seven_day?: {
    used_percentage?: number | null;
    resets_at?: string | number | null;
  } | null;
  updated_at?: string | number | null;
  balance_label?: string | null;
}

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/** Check if usage limit is reached.
 *  For GLM: only 5h at 100% triggers (7d is an estimate, not reliable for limit detection).
 *  For others: either window at 100% triggers. */
export function isLimitReached(data: UsageData): boolean {
  if (data.platform === 'glm') {
    return data.fiveHour === 100;
  }
  return data.fiveHour === 100 || data.sevenDay === 100;
}

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TranscriptData {
  tools: ToolEntry[];
  skills: string[];
  mcpServers: string[];
  agents: AgentEntry[];
  todos: TodoItem[];
  sessionStart?: Date;
  sessionName?: string;
  lastAssistantResponseAt?: Date;
  sessionTokens?: SessionTokenUsage;
  lastCompactBoundaryAt?: Date;
  lastCompactPostTokens?: number;
  // Number of compact_boundary entries (manual /compact or auto compaction)
  // with a valid timestamp seen in the transcript.
  compactionCount?: number;
  // Advisor model ID for the current session, captured from the top-level
  // `advisorModel` field that Claude Code stamps onto every assistant record
  // after `/advisor` is set (e.g. "claude-opus-4-7"). undefined when /advisor
  // is off or no assistant turn has happened yet.
  advisorModel?: string;
}

export interface RenderContext {
  stdin: StdinData;
  transcript: TranscriptData;
  claudeMdCount: number;
  rulesCount: number;
  mcpCount: number;
  hooksCount: number;
  sessionDuration: string;
  gitStatus: GitStatus | null;
  usageData: UsageData | null;
  memoryUsage: MemoryInfo | null;
  config: HudConfig;
  extraLabel: string | null;
  outputStyle?: string;
  claudeCodeVersion?: string;
  effortLevel?: string;
  effortSymbol?: string;
}
