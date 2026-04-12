import type { UsagePlatform } from './types.js';

/** Known GLM API hostnames (lowercase, exact match or subdomain suffix) */
const GLM_DOMAINS = [
  'api.z.ai',
  'open.bigmodel.cn',
  'dev.bigmodel.cn',
];

/**
 * Detect the subscription platform from ANTHROPIC_BASE_URL.
 *
 * Returns 'glm' if the URL hostname matches a known GLM domain (or subdomain),
 * 'anthropic' otherwise (including when the env var is unset or unparseable).
 */
export function detectPlatform(baseUrl?: string): UsagePlatform {
  const url = baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  if (!url) {
    return 'anthropic';
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'anthropic';
  }

  for (const domain of GLM_DOMAINS) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return 'glm';
    }
  }

  return 'anthropic';
}

/**
 * Extract the base domain (protocol + host) from ANTHROPIC_BASE_URL for GLM API calls.
 *
 * Example: 'https://api.z.ai' from 'https://api.z.ai/v4/chat/completions'
 * Returns null if the URL is unset or unparseable.
 */
export function getGlmBaseDomain(baseUrl?: string): string | null {
  const url = baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
