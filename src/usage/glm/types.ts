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
