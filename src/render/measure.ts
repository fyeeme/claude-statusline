import { codePointCellWidth, isCjkAmbiguousWide } from './width.js';

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /^(?:\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_GLOBAL = /(?:\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_ESCAPE_GLOBAL, '');
}

function splitAnsiTokens(str: string): Array<{ type: 'ansi' | 'text'; value: string }> {
  const tokens: Array<{ type: 'ansi' | 'text'; value: string }> = [];
  let i = 0;

  while (i < str.length) {
    const ansiMatch = ANSI_ESCAPE_PATTERN.exec(str.slice(i));
    if (ansiMatch) {
      tokens.push({ type: 'ansi', value: ansiMatch[0] });
      i += ansiMatch[0].length;
      continue;
    }

    let j = i;
    while (j < str.length) {
      const nextAnsi = ANSI_ESCAPE_PATTERN.exec(str.slice(j));
      if (nextAnsi) {
        break;
      }
      j += 1;
    }
    tokens.push({ type: 'text', value: str.slice(i, j) });
    i = j;
  }

  return tokens;
}

export function segmentGraphemes(text: string): string[] {
  if (!text) {
    return [];
  }
  if (!GRAPHEME_SEGMENTER) {
    return Array.from(text);
  }
  return Array.from(GRAPHEME_SEGMENTER.segment(text), segment => segment.segment);
}

export function graphemeWidth(grapheme: string, ambiguousWide: boolean): number {
  if (!grapheme || /^\p{Control}$/u.test(grapheme)) {
    return 0;
  }

  // Emoji glyphs and ZWJ sequences generally render as double-width.
  if (/\p{Extended_Pictographic}/u.test(grapheme)) {
    return 2;
  }

  let hasVisibleBase = false;
  let width = 0;
  for (const char of Array.from(grapheme)) {
    if (/^\p{Mark}$/u.test(char) || char === '\u200D' || char === '\uFE0F') {
      continue;
    }
    hasVisibleBase = true;
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined) {
      width = Math.max(width, codePointCellWidth(codePoint, ambiguousWide));
    } else {
      width = Math.max(width, 1);
    }
  }

  return hasVisibleBase ? width : 0;
}

/** Visible display width of a string, ignoring ANSI escapes and counting
 *  CJK/emoji graphemes as the cells they actually occupy. */
export function visualLength(str: string): number {
  const ambiguousWide = isCjkAmbiguousWide();
  let width = 0;
  for (const token of splitAnsiTokens(str)) {
    if (token.type === 'ansi') {
      continue;
    }
    for (const grapheme of segmentGraphemes(token.value)) {
      width += graphemeWidth(grapheme, ambiguousWide);
    }
  }
  return width;
}
