import type { RenderContext, UsageWindowType } from "../../types.js";
import { isLimitReached } from "../../types.js";
import type { MessageKey } from "../../i18n/types.js";
import { isBedrockModelId } from "../../stdin.js";
import { critical, label, getQuotaColor, quotaBar, RESET } from "../colors.js";
import { getAdaptiveBarWidth } from "../../utils/terminal.js";
import { t } from "../../i18n/index.js";
import { progressLabel } from "./label-align.js";
import type { TimeFormatMode } from "../../config.js";
import { formatResetTime } from "../format-reset-time.js";
import { formatTokenCount } from "../../usage/glm/api.js";
import { estimateSessionCost } from "../../cost.js";

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

  if (isBedrockModelId(ctx.stdin.model?.id)) {
    return null;
  }

  if (ctx.usageData.platform === 'deepseek') {
    return renderDeepSeekUsage(ctx);
  }

  const usageLabel = progressLabel("label.usage", colors, alignLabels);
  const timeFormat: TimeFormatMode = display?.timeFormat ?? 'relative';
  const showResetLabel = display?.showResetLabel ?? true;
  const resetsKey = timeFormat === 'absolute' ? "format.resets" : "format.resetsIn";
  const usageCompact = display?.usageCompact ?? false;

  if (isLimitReached(ctx.usageData)) {
    const resetTime =
      ctx.usageData.fiveHour === 100
        ? formatResetTime(ctx.usageData.fiveHourResetAt, timeFormat)
        : formatResetTime(ctx.usageData.sevenDayResetAt, timeFormat);
    if (usageCompact) {
      return critical(`⚠ Limit${resetTime ? ` (${resetTime})` : ""}`, colors);
    }
    const resetSuffix = resetTime
      ? showResetLabel
        ? ` (${t(resetsKey)} ${resetTime})`
        : ` (${resetTime})`
      : "";
    return `${usageLabel} ${critical(`⚠ ${t("status.limitReached")}${resetSuffix}`, colors)}`;
  }

  const threshold = display?.usageThreshold ?? 0;
  const fiveHour = ctx.usageData.fiveHour;
  const sevenDay = ctx.usageData.sevenDay;

  const effectiveUsage = Math.max(fiveHour ?? 0, sevenDay ?? 0);
  if (effectiveUsage < threshold) {
    return null;
  }

  const sevenDayThreshold = display?.sevenDayThreshold ?? 80;

  if (usageCompact) {
    const fiveHourPart = fiveHour !== null
      ? formatCompactWindowPart("5h", fiveHour, ctx.usageData.fiveHourResetAt, timeFormat, colors)
      : null;
    const sevenDayPart = (sevenDay !== null && (fiveHour === null || sevenDay >= sevenDayThreshold))
      ? formatCompactWindowPart("7d", sevenDay, ctx.usageData.sevenDayResetAt, timeFormat, colors)
      : null;

    if (fiveHourPart && sevenDayPart) {
      return `${fiveHourPart}${separator}${sevenDayPart}`;
    }
    return fiveHourPart ?? sevenDayPart ?? null;
  }

  const usageBarEnabled = display?.usageBarEnabled ?? true;
  const barWidth = getAdaptiveBarWidth();

  if (fiveHour === null && sevenDay !== null) {
    const weeklyOnlyPart = formatUsageWindowPart({
      label: t("label.weekly"),
      labelKey: "label.weekly",
      percent: sevenDay,
      resetAt: ctx.usageData.sevenDayResetAt,
      colors,
      usageBarEnabled,
      barWidth,
      timeFormat,
      showResetLabel,
      forceLabel: true,
      alignLabels,
      windowType: ctx.usageData.sevenDayWindowType,
      tokenCount: ctx.usageData.sevenDayTokens,
    });
    return `${usageLabel} ${weeklyOnlyPart}`;
  }

  const fiveHourPart = formatUsageWindowPart({
    label: "5h",
    percent: fiveHour,
    resetAt: ctx.usageData.fiveHourResetAt,
    colors,
    usageBarEnabled,
    barWidth,
    timeFormat,
    showResetLabel,
    windowType: ctx.usageData.fiveHourWindowType,
  });

  if (sevenDay !== null && sevenDay >= sevenDayThreshold) {
    const sevenDayPart = formatUsageWindowPart({
      label: t("label.weekly"),
      labelKey: "label.weekly",
      percent: sevenDay,
      resetAt: ctx.usageData.sevenDayResetAt,
      colors,
      usageBarEnabled,
      barWidth,
      timeFormat,
      showResetLabel,
      forceLabel: true,
      alignLabels,
      windowType: ctx.usageData.sevenDayWindowType,
      tokenCount: ctx.usageData.sevenDayTokens,
    });
    return `${usageLabel} ${fiveHourPart}${separator}${sevenDayPart}`;
  }

  return `${usageLabel} ${fiveHourPart}`;
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
  // DeepSeek 用 estimate 定价（USD），按余额币种换算（CNY ×7→CNY，USD 不变）
  const cost = estimateSessionCost(ctx.stdin, ctx.transcript?.sessionTokens);
  const exchangeRate = usageData.currency === 'CNY' ? 7 : 1;
  const costStr = cost && cost.totalUsd > 0 ? `${balanceSymbol}${(cost.totalUsd * exchangeRate).toFixed(2)}` : '';

  const parts: string[] = [];
  parts.push(costStr ? `${costStr}/${balance}` : balance);
  if (weekly) parts.push(weekly);
  return label(parts.join(' | '), colors);
}

function formatCompactWindowPart(
  windowLabel: string,
  percent: number | null,
  resetAt: Date | null,
  timeFormat: TimeFormatMode,
  colors?: RenderContext["config"]["colors"],
): string {
  const usageDisplay = formatUsagePercent(percent, colors);
  const reset = formatResetTime(resetAt, timeFormat);
  const styledLabel = label(`${windowLabel}:`, colors);
  return reset
    ? `${styledLabel} ${usageDisplay} ${label(`(${reset})`, colors)}`
    : `${styledLabel} ${usageDisplay}`;
}

function formatUsagePercent(
  percent: number | null,
  colors?: RenderContext["config"]["colors"],
): string {
  if (percent === null) {
    return label("--", colors);
  }
  const color = getQuotaColor(percent, colors);
  return `${color}${percent}%${RESET}`;
}

function formatUsageWindowPart({
  label: windowLabel,
  labelKey,
  percent,
  resetAt,
  colors,
  usageBarEnabled,
  barWidth,
  timeFormat = 'relative',
  showResetLabel,
  forceLabel = false,
  alignLabels = false,
  windowType,
  tokenCount,
}: {
  label: string;
  labelKey?: MessageKey;
  percent: number | null;
  resetAt: Date | null;
  colors?: RenderContext["config"]["colors"];
  usageBarEnabled: boolean;
  barWidth: number;
  timeFormat?: TimeFormatMode;
  showResetLabel: boolean;
  forceLabel?: boolean;
  alignLabels?: boolean;
  windowType?: UsageWindowType;
  tokenCount?: number;
}): string {
  const usageDisplay = formatUsagePercent(percent, colors);
  const reset = formatResetTime(resetAt, timeFormat);
  const styledLabel = labelKey
    ? progressLabel(labelKey, colors, alignLabels)
    : label(windowLabel, colors);
  const resetsKey = timeFormat === 'absolute' ? "format.resets" : "format.resetsIn";

  const isSemanticWindow = windowType === 'rolling' || windowType === 'cycle';

  // Build suffix for semantic (rolling/cycle) windows
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

  // For fixed windows (Anthropic), show reset time
  if (!isSemanticWindow) {
    const resetSuffix = reset
      ? showResetLabel
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
