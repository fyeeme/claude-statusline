import { sanitize as sanitizeDisplayText } from './sanitize.js';

function hyperlink(uri: string, text: string): string {
  const esc = '\x1b';
  const st = '\\';
  return `${esc}]8;;${uri}${esc}${st}${text}${esc}]8;;${esc}${st}`;
}

export function safeHyperlink(uri: string | undefined | null, text: string): string {
  if (!uri) {
    return text;
  }

  const sanitizedUri = sanitizeDisplayText(uri);
  try {
    const parsed = new URL(sanitizedUri);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
      return text;
    }
    return hyperlink(parsed.toString(), text);
  } catch {
    return text;
  }
}
