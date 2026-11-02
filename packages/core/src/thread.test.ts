import { describe, expect, it } from 'vitest';
import { splitThread, ThreadSplitError } from './thread.js';
import { DEFAULT_LIMITS } from './limits.js';
import { countWeighted, fits } from './text.js';

const X = DEFAULT_LIMITS.x.text;
const BSKY = DEFAULT_LIMITS.bluesky.text;
const FC = DEFAULT_LIMITS.farcaster.text;

describe('splitThread', () => {
  it('returns a single part when the text fits', () => {
    const r = splitThread('Hello world', { limits: X });
    expect(r.parts).toEqual(['Hello world']);
    expect(r.manual).toBe(false);
  });

  it('splits at paragraph boundaries first and appends markers', () => {
    const p1 = 'A'.repeat(200);
    const p2 = 'B'.repeat(200);
    const r = splitThread(`${p1}\n\n${p2}`, { limits: X });
    expect(r.parts).toHaveLength(2);
    expect(r.parts[0]).toBe(`${p1} (1/2)`);
    expect(r.parts[1]).toBe(`${p2} (2/2)`);
    for (const p of r.parts) expect(fits(p, X)).toBe(true);
  });

  it('falls back to sentences, then words', () => {
    const sentence = 'This is a reasonably long sentence that keeps going for a while. ';
    const text = sentence.repeat(12).trim();
    const r = splitThread(text, { limits: X });
    expect(r.parts.length).toBeGreaterThan(2);
    for (const p of r.parts) expect(countWeighted(p)).toBeLessThanOrEqual(280);
    // Every part ends with a marker.
    for (const [i, p] of r.parts.entries())
      expect(p.endsWith(`(${i + 1}/${r.parts.length})`)).toBe(true);
    // Nothing lost: joined text (without markers) contains every sentence.
    const joined = r.parts.map((p) => p.replace(/ \(\d+\/\d+\)$/, '')).join(' ');
    expect(joined.split('while.').length).toBe(text.split('while.').length);
  });

  it('never splits URLs or @mentions', () => {
    const url =
      'https://example.com/a/very/long/path/that/goes/on/and/on/and/on/and/on/and/on/and/on/x';
    const words = 'word '.repeat(50).trim();
    const text = `${words} ${url} @someone_with_a_long_handle ${words}`;
    const r = splitThread(text, { limits: X });
    const all = r.parts.join(' ');
    expect(all).toContain(url);
    expect(all).toContain('@someone_with_a_long_handle');
    for (const p of r.parts) expect(fits(p, X)).toBe(true);
  });

  it('honours manual --- separators', () => {
    const r = splitThread('First part\n---\nSecond part\n---\nThird', { limits: X });
    expect(r.manual).toBe(true);
    expect(r.parts).toEqual(['First part (1/3)', 'Second part (2/3)', 'Third (3/3)']);
  });

  it('rejects a manual part that is too long', () => {
    expect(() => splitThread(`${'x'.repeat(300)}\n---\nok`, { limits: X })).toThrow(
      ThreadSplitError,
    );
  });

  it('respects marker disabled', () => {
    const r = splitThread(`${'A'.repeat(200)}\n\n${'B'.repeat(200)}`, {
      limits: X,
      marker: { enabled: false, format: '' },
    });
    expect(r.parts).toEqual(['A'.repeat(200), 'B'.repeat(200)]);
  });

  it('measures Bluesky in graphemes and Farcaster in bytes', () => {
    const emoji = '👩‍👩‍👧‍👦'; // 1 grapheme, many bytes
    const text = `${emoji} `.repeat(150).trim(); // 150 graphemes, way over 320 bytes
    // 150 graphemes < 300, but ~3,900 bytes > 3,000 → the secondary byte cap forces a split.
    const b = splitThread(text, { limits: BSKY });
    expect(b.parts.length).toBeGreaterThan(1);
    for (const p of b.parts) expect(fits(p, BSKY)).toBe(true);
    // A short plain string stays whole.
    expect(splitThread('short', { limits: BSKY }).parts).toEqual(['short']);
    const f = splitThread(text, { limits: FC });
    expect(f.parts.length).toBeGreaterThan(1);
    for (const p of f.parts) expect(fits(p, FC)).toBe(true);
  });

  it('throws when too many parts would be needed', () => {
    expect(() => splitThread('word '.repeat(5000), { limits: X, maxParts: 5 })).toThrow(
      ThreadSplitError,
    );
  });
});
