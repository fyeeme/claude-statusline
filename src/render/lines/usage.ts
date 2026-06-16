import type { RenderContext, UsageWindowType } from "../../types.js";
import { isLimitReached } from "../../types.js";
import type { MessageKey } from "../../i18n/types.js";
import { shouldHideUsage } from "../../stdin.js";
import { critical, label, getQuotaColor, quotaBar, RESET } from "../colors.js";
import { getAdaptiveBarWidth } from "../../utils/terminal.js";
import { t } from "../../i18n/index.js";
import { progressLabel } from "./label-align.js";
import type { TimeFormatMode, UsageValueMode } from "../../config.js";
import { formatResetTime } from "../format-reset-time.js";
import { formatTokenCount } from "../../usage/glm/api.js";
import { estimateSessionCost } from "../../cost.js";

const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function renderUsageLine(
  ctx: RenderContext,
  alignLabels = false,
): string | null {
  const display = ctx.config?.display;
  const colors = ctx.config?.colors;
  const separator = display?.separator ?? '｜';

  if (display?.showUsage === false) {
    return null;
  }

  if (!ctx.usageData) {
    return null;
  }

  if (shouldHideUsage(ctx.stdin)) {
    return null;
  }

  // DeepSeek provider: structured balance / weekly tokens / session cost
  if (ctx.usageData.platform === 'deepseek') {
    return renderDeepSeekUsage(ctx);
  }

  const usageLabel = progressLabel("label.usage", colors, alignLabels);
  const balanceLabel = ctx.usageData.balanceLabel ?? null;
  const hasWindowData = ctx.usageData.fiveHour !== null || ctx.usageData.sevenDay !== null;

  // Balance-only (anthropic external snapshot with no window data)
  if (balanceLabel && !hasWindowData) {
    return `${usageLabel} ${balanceLabel}`;
  }

  const timeFormat = normalizeTimeFormat(display?.timeFormat);
  const showResetLabel = display?.showResetLabel ?? true;
  const resetsKey = limitResetTimeFormat(timeFormat) === 'absolute' ? "format.resets" : "format.resetsIn";
  const usageCompact = display?.usageCompact ?? false;
  const usageValueMode = display?.usageValue ?? 'percent';

  if (isLimitReached(ctx.usageData)) {
    const limitTimeFormat = limitResetTimeFormat(timeFormat);
    const resetTime =
      ctx.usageData.fiveHour === 100
        ? formatResetTime(ctx.usageData.fiveHourResetAt, limitTimeFormat)
        : formatResetTime(ctx.usageData.sevenDayResetAt, limitTimeFormat);
    if (usageCompact) {
      return appendBalance(critical(`⚠ Limit${resetTime ? ` (${resetTime})` : ""}`, colors), balanceLabel, separator);
    }
    const resetSuffix = resetTime
      ? showResetLabel
        ? ` (${t(resetsKey)} ${resetTime})`
        : ` (${resetTime})`
      : "";
    return appendBalance(`${usageLabel} ${critical(`⚠ ${t("status.limitReached")}${resetSuffix}`, colors)}`, balanceLabel, separator);
  }

  const threshold = display?.usageThreshold ?? 0;
  const fiveHour = ctx.usageData.fiveHour;
  const sevenDay = ctx.usageData.sevenDay;

  const effectiveUsage = Math.max(fiveHour ?? 0, sevenDay ?? 0);
  if (effectiveUsage < threshold) {
    return balanceLabel ? `${usageLabel} ${balanceLabel}` : null;
  }

  const sevenDayThreshold = display?.sevenDayThreshold ?? 80;

  if (usageCompact) {
    const fiveHourPart = fiveHour !== null
      ? formatCompactWindowPart("5h", fiveHour, ctx.usageData.fiveHourResetAt, FIVE_HOUR_WINDOW_MS, timeFormat, colors, usageValueMode)
      : null;
    const sevenDayPart = (sevenDay !== null && (fiveHour === null || sevenDay >= sevenDayThreshold))
      ? formatCompactWindowPart("7d", sevenDay, ctx.usageData.sevenDayResetAt, SEVEN_DAY_WINDOW_MS, timeFormat, colors, usageValueMode)
      : null;

    if (fiveHourPart && sevenDayPart) {
      return appendBalance(`${fiveHourPart}${separator}${sevenDayPart}`, balanceLabel, separator);
    }
    // 无 unit:6 周限额但有自然周 token (GLM)
    if (fiveHourPart && sevenDay === null && ctx.usageData.sevenDayTokens && ctx.usageData.sevenDayTokens > 0) {
      return appendBalance(`${fiveHourPart}${separator}${label(`7d:${formatTokenCount(ctx.usageData.sevenDayTokens)}`, colors)}`, balanceLabel, separator);
    }
    const compactLine = fiveHourPart ?? sevenDayPart;
    return compactLine ? appendBalance(compactLine, balanceLabel, separator) : null;
  }

  const usageBarEnabled = display?.usageBarEnabled ?? true;
  const barWidth = getAdaptiveBarWidth();

  if (fiveHour === null && sevenDay !== null) {
    const weeklyOnlyPart = formatUsageWindowPart({
      label: t("label.weekly"),
      labelKey: "label.weekly",
      percent: sevenDay,
      resetAt: ctx.usageData.sevenDayResetAt,
      windowMs: SEVEN_DAY_WINDOW_MS,
      colors,
      usageBarEnabled,
      barWidth,
      timeFormat,
      showResetLabel,
      forceLabel: true,
      alignLabels,
      usageValueMode,
      windowType: ctx.usageData.sevenDayWindowType,
      tokenCount: ctx.usageData.sevenDayTokens,
    });
    return appendBalance(`${usageLabel} ${weeklyOnlyPart}`, balanceLabel, separator);
  }

  const fiveHourPart = formatUsageWindowPart({
    label: "5h",
    percent: fiveHour,
    resetAt: ctx.usageData.fiveHourResetAt,
    windowMs: FIVE_HOUR_WINDOW_MS,
    colors,
    usageBarEnabled,
    barWidth,
    timeFormat,
    showResetLabel,
    usageValueMode,
    windowType: ctx.usageData.fiveHourWindowType,
  });

  if (sevenDay !== null && sevenDay >= sevenDayThreshold) {
    const sevenDayPart = formatUsageWindowPart({
      label: t("label.weekly"),
      labelKey: "label.weekly",
      percent: sevenDay,
      resetAt: ctx.usageData.sevenDayResetAt,
      windowMs: SEVEN_DAY_WINDOW_MS,
      colors,
      usageBarEnabled,
      barWidth,
      timeFormat,
      showResetLabel,
      forceLabel: true,
      alignLabels,
      usageValueMode,
      windowType: ctx.usageData.sevenDayWindowType,
      tokenCount: ctx.usageData.sevenDayTokens,
    });
    return appendBalance(`${usageLabel} ${fiveHourPart}${separator}${sevenDayPart}`, balanceLabel, separator);
  }

  // 无 unit:6 周限额但有自然周 token → 显示 7d:<tokens>
  if (sevenDay === null && ctx.usageData.sevenDayTokens && ctx.usageData.sevenDayTokens > 0) {
    return appendBalance(`${usageLabel} ${fiveHourPart}${separator}${label(`7d:${formatTokenCount(ctx.usageData.sevenDayTokens)}`, colors)}`, balanceLabel, separator);
  }

  return appendBalance(`${usageLabel} ${fiveHourPart}`, balanceLabel, separator);
}

/** DeepSeek usage display: $sessionCost/balance · 7d:weeklyTokens */
export function renderDeepSeekUsage(ctx: RenderContext): string {
  const usageData = ctx.usageData!;
  const colors = ctx.config?.colors;
  const balanceSymbol = usageData.currency === 'CNY' ? '¥' : '$';
  const balance = `${balanceSymbol}${usageData.balance ?? '?'}`;
  const weekly = usageData.weeklyTokens && usageData.weeklyTokens > 0
    ? `7d:${formatTokenCount(usageData.weeklyTokens)}`
    : '';
  // DeepSeek pricing 为 USD，按余额币种换算（CNY ×7，USD 不变）
  const cost = estimateSessionCost(ctx.stdin, ctx.transcript?.sessionTokens);
  const exchangeRate = usageData.currency === 'CNY' ? 7 : 1;
  const costStr = cost && cost.totalUsd > 0 ? `${balanceSymbol}${(cost.totalUsd * exchangeRate).toFixed(2)}` : '';

  const parts: string[] = [];
  parts.push(costStr ? `${costStr}/${balance}` : balance);
  if (weekly) parts.push(weekly);
  return label(parts.join(' | '), colors);
}

function appendBalance(line: string, balanceLabel: string | null, separator: string): string {
  return balanceLabel ? `${line}${separator}${balanceLabel}` : line;
}

function formatCompactWindowPart(
  windowLabel: string,
  percent: number | null,
  resetAt: Date | null,
  windowMs: number,
  timeFormat: TimeFormatMode,
  colors?: RenderContext["config"]["colors"],
  usageValueMode: UsageValueMode = 'percent',
): string {
  const usageDisplay = formatUsagePercent(percent, colors, usageValueMode);
  const reset = formatWindowTime(resetAt, windowMs, timeFormat);
  const styledLabel = label(`${windowLabel}:`, colors);
  return reset
    ? `${styledLabel} ${usageDisplay} ${label(`(${reset})`, colors)}`
    : `${styledLabel} ${usageDisplay}`;
}

function formatUsagePercent(
  percent: number | null,
  colors?: RenderContext["config"]["colors"],
  mode: UsageValueMode = 'percent',
): string {
  if (percent === null) {
    return label("--", colors);
  }
  const color = getQuotaColor(percent, colors);
  const displayPercent = mode === 'remaining' ? Math.max(0, 100 - percent) : percent;
  return `${color}${displayPercent}%${RESET}`;
}

function formatUsageWindowPart({
  label: windowLabel,
  labelKey,
  percent,
  resetAt,
  windowMs,
  colors,
  usageBarEnabled,
  barWidth,
  timeFormat = 'relative',
  showResetLabel,
  forceLabel = false,
  alignLabels = false,
  usageValueMode = 'percent',
  windowType,
  tokenCount,
}: {
  label: string;
  labelKey?: MessageKey;
  percent: number | null;
  resetAt: Date | null;
  windowMs: number;
  colors?: RenderContext["config"]["colors"];
  usageBarEnabled: boolean;
  barWidth: number;
  timeFormat?: TimeFormatMode;
  showResetLabel: boolean;
  forceLabel?: boolean;
  alignLabels?: boolean;
  usageValueMode?: UsageValueMode;
  windowType?: UsageWindowType;
  tokenCount?: number;
}): string {
  const usageDisplay = formatUsagePercent(percent, colors, usageValueMode);
  const reset = formatWindowTime(resetAt, windowMs, timeFormat);
  const styledLabel = labelKey
    ? progressLabel(labelKey, colors, alignLabels)
    : label(windowLabel, colors);
  const isSemanticWindow = windowType === 'rolling' || windowType === 'cycle';

  // Build suffix for semantic (rolling/cycle) windows (GLM)
  let suffix = '';
  if (windowType === 'cycle' && tokenCount != null && tokenCount > 0) {
    // 7d with tokens: "138M, 5d 3h" (token count + remaining time)
    suffix = reset ? ` (${formatTokenCount(tokenCount)}, ${reset})` : ` (${formatTokenCount(tokenCount)})`;
  } else if (windowType === 'cycle' && resetAt != null) {
    // 5h cycle: remaining time "3h 30m"
    suffix = reset ? ` (${reset})` : '';
  } else if (windowType === 'cycle') {
    suffix = ` (${styledLabel})`;
  } else if (windowType === 'rolling') {
    suffix = ` (${styledLabel})`;
  }

  // For fixed windows (Anthropic), show reset wording
  if (!isSemanticWindow) {
    const showResetWording = timeFormat !== 'elapsed' && timeFormat !== 'elapsedAndAbsolute';
    const resetsKey = timeFormat === 'absolute' ? "format.resets" : "format.resetsIn";

    const resetSuffix = reset
      ? showResetLabel && showResetWording
        ? `(${t(resetsKey)} ${reset})`
        : `(${reset})`
      : "";

    if (usageBarEnabled) {
      const body = resetSuffix
        ? `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay} ${resetSuffix}`
        : `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay}`;
      return forceLabel ? `${styledLabel} ${body}` : body;
    }

    return resetSuffix
      ? `${styledLabel} ${usageDisplay} ${resetSuffix}`
      : `${styledLabel} ${usageDisplay}`;
  }

  // Rolling/cycle: show suffix with token count
  if (usageBarEnabled) {
    const body = `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay}${suffix}`;
    return forceLabel ? `${styledLabel} ${body}` : body;
  }

  return `${styledLabel} ${usageDisplay}${suffix}`;
}

function normalizeTimeFormat(value: unknown): TimeFormatMode {
  if (
    value === 'absolute'
    || value === 'both'
    || value === 'elapsed'
    || value === 'elapsedAndAbsolute'
  ) {
    return value;
  }

  return 'relative';
}

function limitResetTimeFormat(timeFormat: TimeFormatMode): 'relative' | 'absolute' | 'both' {
  if (timeFormat === 'elapsedAndAbsolute') {
    return 'absolute';
  }

  if (timeFormat === 'elapsed') {
    return 'relative';
  }

  return timeFormat;
}

function formatWindowTime(
  resetAt: Date | null,
  windowMs: number,
  timeFormat: TimeFormatMode,
): string {
  if (timeFormat === 'elapsed') {
    return formatElapsedWindow(resetAt, windowMs);
  }

  if (timeFormat === 'elapsedAndAbsolute') {
    const elapsed = formatElapsedWindow(resetAt, windowMs);
    const absolute = formatResetTime(resetAt, 'absolute');
    if (elapsed && absolute) {
      return `${elapsed}, ${absolute}`;
    }
    return elapsed || absolute;
  }

  return formatResetTime(resetAt, timeFormat);
}

function formatElapsedWindow(resetAt: Date | null, windowMs: number): string {
  if (!resetAt) {
    return '';
  }

  const windowStart = resetAt.getTime() - windowMs;
  const rawElapsed = ((Date.now() - windowStart) / windowMs) * 100;
  const elapsed = Math.max(0, Math.min(100, Math.round(rawElapsed)));
  return `${elapsed}% elapsed`;
}
