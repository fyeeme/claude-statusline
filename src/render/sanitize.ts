export const CONTROL_AND_BIDI_PATTERN = new RegExp(
  '[' +
  '\\u0000-\\u001F\\u007F-\\u009F' +
  '\\u061C\\u200E\\u200F' +
  '\\u202A-\\u202E\\u2066-\\u2069\\u206A-\\u206F' +
  ']',
  'g',
);

export function sanitize(value: string): string {
  return value.replace(CONTROL_AND_BIDI_PATTERN, '');
}
