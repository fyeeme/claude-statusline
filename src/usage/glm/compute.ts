export function compute7d(tokens7d: number, calibratedLimit7d: number): number | null {
  if (calibratedLimit7d <= 0) return null;
  const raw = Math.round((tokens7d / calibratedLimit7d) * 100);
  return Math.max(0, Math.min(100, raw));
}

export function applyMonotonicGuard(
  sevenDay: number | null,
  sevenDayTokens: number | undefined,
  previousSevenDay: number | null,
  previousSevenDayTokens: number | undefined,
  sameCycle: boolean,
): { sevenDay: number | null; sevenDayTokens: number | undefined } {
  if (!sameCycle) {
    return { sevenDay, sevenDayTokens };
  }

  const prevToks =
    previousSevenDayTokens !== null && previousSevenDayTokens !== undefined
      ? previousSevenDayTokens
      : undefined;
  const newToks =
    sevenDayTokens !== null && sevenDayTokens !== undefined
      ? sevenDayTokens
      : undefined;

  const tokenDropIsMassive =
    prevToks !== undefined &&
    newToks !== undefined &&
    newToks < prevToks * 0.5;

  if (tokenDropIsMassive) {
    return { sevenDay, sevenDayTokens };
  }

  const guardedPct =
    sevenDay !== null && previousSevenDay !== null && sevenDay < previousSevenDay
      ? previousSevenDay
      : sevenDay;

  const guardedTokens =
    newToks !== undefined && prevToks !== undefined && newToks < prevToks
      ? (previousSevenDayTokens as number | undefined)
      : sevenDayTokens;

  return { sevenDay: guardedPct, sevenDayTokens: guardedTokens };
}
