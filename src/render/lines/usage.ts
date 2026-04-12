import type { RenderContext, UsageWindowType } from "../../types.js";
import { isLimitReached } from "../../types.js";
import { getProviderLabel } from "../../stdin.js";
import { critical, label, getQuotaColor, quotaBar, RESET } from "../colors.js";
import { getAdaptiveBarWidth } from "../../utils/terminal.js";
import { t } from "../../i18n/index.js";
import { formatTokenCount } from "../../glm-usage.js";

export function renderUsageLine(ctx: RenderContext): string | null {
  const display = ctx.config?.display;
  const colors = ctx.config?.colors;

  if (display?.showUsage === false) {
    return null;
  }

  if (!ctx.usageData) {
    return null;
  }

  if (getProviderLabel(ctx.stdin)) {
    return null;
  }

  const usageLabel = label(t("label.usage"), colors);
  const isGlm = ctx.usageData.platform === 'glm';

  if (isLimitReached(ctx.usageData)) {
    const resetTime =
      ctx.usageData.fiveHour === 100
        ? formatResetTime(ctx.usageData.fiveHourResetAt)
        : formatResetTime(ctx.usageData.sevenDayResetAt);
    return `${usageLabel} ${critical(`⚠ ${t("status.limitReached")}${resetTime ? ` (${t("format.resets")} ${resetTime})` : ""}`, colors)}`;
  }

  const threshold = display?.usageThreshold ?? 0;
  const fiveHour = ctx.usageData.fiveHour;
  const sevenDay = ctx.usageData.sevenDay;

  const effectiveUsage = Math.max(fiveHour ?? 0, sevenDay ?? 0);
  if (effectiveUsage < threshold) {
    return null;
  }

  const usageBarEnabled = display?.usageBarEnabled ?? true;
  // R9b: GLM threshold override — always show 7d bar for GLM
  const sevenDayThreshold = isGlm ? 0 : (display?.sevenDayThreshold ?? 80);
  const barWidth = Math.max(4, getAdaptiveBarWidth());

  if (fiveHour === null && sevenDay !== null) {
    const weeklyOnlyPart = formatUsageWindowPart({
      label: isGlm ? "7d" : t("label.weekly"),
      percent: sevenDay,
      resetAt: ctx.usageData.sevenDayResetAt,
      colors,
      usageBarEnabled,
      barWidth,
      forceLabel: true,
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
    windowType: ctx.usageData.fiveHourWindowType,
  });

  if (sevenDay !== null && sevenDay >= sevenDayThreshold) {
    const sevenDayPart = formatUsageWindowPart({
      label: isGlm ? "7d" : t("label.weekly"),
      percent: sevenDay,
      resetAt: ctx.usageData.sevenDayResetAt,
      colors,
      usageBarEnabled,
      barWidth,
      forceLabel: true,
      windowType: ctx.usageData.sevenDayWindowType,
      tokenCount: ctx.usageData.sevenDayTokens,
    });
    return `${usageLabel} ${fiveHourPart} | ${sevenDayPart}`;
  }

  return `${usageLabel} ${fiveHourPart}`;
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
  percent,
  resetAt,
  colors,
  usageBarEnabled,
  barWidth,
  forceLabel = false,
  windowType,
  tokenCount,
}: {
  label: string;
  percent: number | null;
  resetAt: Date | null;
  colors?: RenderContext["config"]["colors"];
  usageBarEnabled: boolean;
  barWidth: number;
  forceLabel?: boolean;
  windowType?: UsageWindowType;
  tokenCount?: number;
}): string {
  const usageDisplay = formatUsagePercent(percent, colors);
  const styledLabel = label(windowLabel, colors);

  // For rolling/estimated windows: no reset time, add semantic label
  const isSemanticWindow = windowType === 'rolling' || windowType === 'estimated';

  // Build suffix: token count for estimated, window type label for rolling
  let suffix = '';
  if (windowType === 'rolling') {
    suffix = ` (${styledLabel})`;
  } else if (windowType === 'estimated' && tokenCount != null && tokenCount > 0) {
    suffix = ` (${formatTokenCount(tokenCount)} / ${styledLabel})`;
  }

  // For fixed windows (Anthropic), show reset time if available
  if (!isSemanticWindow) {
    const reset = formatResetTime(resetAt);
    if (usageBarEnabled) {
      const body = reset
        ? `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay} (${t("format.resetsIn")} ${reset})`
        : `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay}`;
      return forceLabel ? `${styledLabel} ${body}` : body;
    }

    return reset
      ? `${styledLabel} ${usageDisplay} (${t("format.resetsIn")} ${reset})`
      : `${styledLabel} ${usageDisplay}`;
  }

  // Rolling/estimated: no reset time, show suffix
  if (usageBarEnabled) {
    const body = `${quotaBar(percent ?? 0, barWidth, colors)} ${usageDisplay}${suffix}`;
    return forceLabel ? `${styledLabel} ${body}` : body;
  }

  return `${styledLabel} ${usageDisplay}${suffix}`;
}

function formatResetTime(resetAt: Date | null): string {
  if (!resetAt) return "";
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();
  if (diffMs <= 0) return "";

  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    if (remHours > 0) return `${days}d ${remHours}h`;
    return `${days}d`;
  }

  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
