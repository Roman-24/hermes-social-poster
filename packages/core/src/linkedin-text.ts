/**
 * LinkedIn's /rest/posts `commentary` uses the "little" text format. These characters must be
 * backslash-escaped or the post is silently truncated at the first one.
 */
const LITTLE_TEXT_SPECIALS = /[\\|{}@[\]()<>#*_~]/g;

export function escapeLinkedInText(text: string): string {
  return text.replace(LITTLE_TEXT_SPECIALS, (ch) => `\\${ch}`);
}

export function unescapeLinkedInText(text: string): string {
  return text.replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1');
}
