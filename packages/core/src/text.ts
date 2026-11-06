import twitter from 'twitter-text';
import type { TextUnit, TextLimits } from './limits.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function countGraphemes(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

export function countBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function countChars(text: string): number {
  return Array.from(text).length;
}

/**
 * twitter-text backtracks badly on a long run of characters without whitespace (for example
 * "1.1.1.1." repeated): the cost grows quadratically with the run length. No real post has a
 * token this long, and such a token cannot fit any weighted limit anyway unless it is a URL, so
 * past this length the plain code point count is returned instead of calling the parser. The
 * count is only used to decide that the text is over the limit.
 */
const MAX_PARSE_RUN = 2_000;
const LONG_RUN_RE = new RegExp(`\\S{${MAX_PARSE_RUN + 1},}`);

/** X weighted length (URLs = 23, CJK = 2, emoji = 2). */
export function countWeighted(text: string): number {
  if (LONG_RUN_RE.test(text)) return countChars(text);
  return twitter.parseTweet(text).weightedLength;
}

export function measure(text: string, unit: TextUnit): number {
  switch (unit) {
    case 'weighted':
      return countWeighted(text);
    case 'bytes':
      return countBytes(text);
    case 'graphemes':
      return countGraphemes(text);
    case 'chars':
    case 'none':
      return countChars(text);
  }
}

export interface Measurement {
  count: number;
  max: number;
  unit: TextUnit;
  over: boolean;
  /** Bluesky secondary byte limit, when applicable. */
  bytes?: number;
  maxBytes?: number;
}

export function measureAgainst(text: string, limits: TextLimits): Measurement {
  const count = measure(text, limits.unit);
  const m: Measurement = { count, max: limits.max, unit: limits.unit, over: count > limits.max };
  if (limits.secondaryMaxBytes !== undefined) {
    m.bytes = countBytes(text);
    m.maxBytes = limits.secondaryMaxBytes;
    if (m.bytes > limits.secondaryMaxBytes) m.over = true;
  }
  return m;
}

/** Returns true if the text fits the limits (all units). */
export function fits(text: string, limits: TextLimits): boolean {
  return !measureAgainst(text, limits).over;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

/** Tokens that must never be broken by the splitter: URLs, @mentions, #tags. */
export function isAtomicToken(token: string): boolean {
  return /^(https?:\/\/|www\.|@|#)/i.test(token);
}
