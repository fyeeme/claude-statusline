/** Persistent calibration state — stored in .usage-state.json */
export interface CalibrationState {
  calibratedLimit7d: number | null;
  calibratedAt: number;
  /** Inferred subscription time in ms since epoch */
  subscriptionTimeMs: number | null;
}

/** Result from full API fetch (quota + model-usage) */
export interface FetchedData {
  fiveHourPct: number | null;
  tokens5h: number;
  tokens7d: number;
  tokensLimitResetTime: number | null;
  timeLimitResetTime: number | null;
  weeklyPct: number | null;
  weeklyResetTime: number | null;
}

/** Auth failure (401/403) — cannot retry without new credentials */
export class GlmAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlmAuthError';
  }
}

/** Transient failure (429/5xx/network) — can retry after backoff */
export class GlmRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlmRetryableError';
  }
}
