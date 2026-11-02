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

/** X weighted length (URLs = 23, CJK = 2, emoji = 2). */
export function countWeighted(text: string): number {
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
