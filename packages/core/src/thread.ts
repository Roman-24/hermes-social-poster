import type { TextLimits } from './limits.js';
import { fits, isAtomicToken, measureAgainst } from './text.js';

export interface ThreadMarkerOptions {
  enabled: boolean;
  /** Format with {i} and {n}; default "(1/n)" style, separated from text by a space. */
  format: string;
}

export const DEFAULT_MARKER: ThreadMarkerOptions = { enabled: true, format: '({i}/{n})' };

export interface SplitOptions {
  limits: TextLimits;
  marker?: ThreadMarkerOptions;
  /** Hard cap on parts; beyond it a validation error is better than a 50-part thread. */
  maxParts?: number;
}

export interface SplitResult {
  parts: string[];
  /** True if a manual `---` separator was used. */
  manual: boolean;
  /** Non-fatal notes, e.g. an atomic token longer than the limit. */
  issues: string[];
}

export class ThreadSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadSplitError';
  }
}

/**
 * A separator is a line holding only `---` and horizontal whitespace. The whitespace class must
 * not match line breaks: with `\s*` the engine retries from every line start and the test is
 * quadratic in the number of blank lines, which one draft request could turn into a long stall.
 */
const HSPACE = '[^\\S\\r\\n\\u2028\\u2029]*';
const MANUAL_SEPARATOR_RE = new RegExp(`^${HSPACE}---${HSPACE}$`, 'm');
const MANUAL_SEPARATOR_ALL_RE = new RegExp(`^${HSPACE}---${HSPACE}$`, 'gm');

export function hasManualBreaks(text: string): boolean {
  return MANUAL_SEPARATOR_RE.test(text);
}

/** Split on lines that are exactly `---`. */
export function splitManual(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(MANUAL_SEPARATOR_ALL_RE)) {
    parts.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function renderMarker(format: string, i: number, n: number): string {
  return format.replaceAll('{i}', String(i)).replaceAll('{n}', String(n));
}

/** Longest marker suffix for n parts (for reservation). */
function markerSuffix(format: string, i: number, n: number): string {
  return ` ${renderMarker(format, i, n)}`;
}

/**
 * Split `text` into parts that each fit `limits`.
 * Order of preference: paragraphs → sentences → words. Atomic tokens (URLs, @mentions, #tags)
 * are never split; if one alone exceeds the limit, it is placed in its own part and reported.
 */
export function splitThread(text: string, opts: SplitOptions): SplitResult {
  const marker = opts.marker ?? DEFAULT_MARKER;
  const maxParts = opts.maxParts ?? 25;
  const issues: string[] = [];
  const trimmed = text.trim();

  if (hasManualBreaks(trimmed)) {
    const parts = splitManual(trimmed);
    const withMarkers = applyMarkers(parts, marker);
    for (const [i, p] of withMarkers.entries()) {
      if (!fits(p, opts.limits)) {
        throw new ThreadSplitError(
          `Manual part ${i + 1} exceeds the limit (${measureAgainst(p, opts.limits).count}/${opts.limits.max}).`,
        );
      }
    }
    return { parts: withMarkers, manual: true, issues };
  }

  if (fits(trimmed, opts.limits)) return { parts: [trimmed], manual: false, issues };

  // Iterate: reserve space for a marker sized for an estimated part count, split, check.
  let estimateN = 2;
  for (let round = 0; round < 6; round++) {
    const reserve = marker.enabled ? markerSuffix(marker.format, estimateN, estimateN) : '';
    const parts = greedySplit(trimmed, opts.limits, reserve, issues);
    if (parts.length > maxParts) {
      throw new ThreadSplitError(`Text would need ${parts.length} parts (max ${maxParts}).`);
    }
    const withMarkers = applyMarkers(parts, marker);
    if (withMarkers.every((p) => fits(p, opts.limits))) {
      return { parts: withMarkers, manual: false, issues: dedupe(issues) };
    }
    estimateN = Math.max(parts.length, estimateN * 10);
  }
  throw new ThreadSplitError('Could not split text into parts that fit the limit.');
}

function applyMarkers(parts: string[], marker: ThreadMarkerOptions): string[] {
  if (!marker.enabled || parts.length <= 1) return parts;
  const n = parts.length;
  return parts.map((p, idx) => `${p}${markerSuffix(marker.format, idx + 1, n)}`);
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function fitsWithReserve(text: string, limits: TextLimits, reserve: string): boolean {
  return fits(text + reserve, limits);
}

/** Greedy accumulation of units; a unit that does not fit alone is broken down further. */
function greedySplit(
  text: string,
  limits: TextLimits,
  reserve: string,
  issues: string[],
): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let current = '';

  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };

  const append = (unit: string, joiner: string) => {
    const candidate = current ? `${current}${joiner}${unit}` : unit;
    if (fitsWithReserve(candidate, limits, reserve)) {
      current = candidate;
      return true;
    }
    return false;
  };

  for (const para of paragraphs) {
    if (append(para, '\n\n')) continue;
    push();
    if (fitsWithReserve(para, limits, reserve)) {
      current = para;
      continue;
    }
    // Paragraph alone is too long: sentences.
    for (const sentence of splitSentences(para)) {
      if (append(sentence, ' ')) continue;
      push();
      if (fitsWithReserve(sentence, limits, reserve)) {
        current = sentence;
        continue;
      }
      // Sentence alone too long: words (atomic tokens stay whole).
      for (const word of sentence.split(/\s+/).filter(Boolean)) {
        if (append(word, ' ')) continue;
        push();
        if (fitsWithReserve(word, limits, reserve)) {
          current = word;
          continue;
        }
        if (isAtomicToken(word)) {
          issues.push(`"${truncate(word, 40)}" is longer than the limit and was kept whole.`);
          out.push(word);
          continue;
        }
        // Last resort: hard-split a very long plain token.
        for (const chunk of hardSplit(word, limits, reserve)) {
          if (!append(chunk, '')) {
            push();
            current = chunk;
          }
        }
      }
    }
  }
  push();
  return out;
}

function splitSentences(paragraph: string): string[] {
  // Split after . ! ? … followed by whitespace; keep line breaks as boundaries too.
  const parts = paragraph
    .split(/(?<=[.!?…])\s+|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [paragraph];
}

function hardSplit(token: string, limits: TextLimits, reserve: string): string[] {
  const chars = Array.from(token);
  const chunks: string[] = [];
  let cur = '';
  for (const ch of chars) {
    if (fitsWithReserve(cur + ch, limits, reserve)) cur += ch;
    else {
      if (cur) chunks.push(cur);
      cur = ch;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
