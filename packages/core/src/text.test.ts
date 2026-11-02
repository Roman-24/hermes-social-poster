import { describe, expect, it } from 'vitest';
import { countBytes, countGraphemes, countWeighted, measureAgainst } from './text.js';
import { escapeLinkedInText, unescapeLinkedInText } from './linkedin-text.js';
import { DEFAULT_LIMITS, mergeLimits } from './limits.js';
import { derivePostStatus } from './states.js';

describe('text measurement', () => {
  it('counts X weighted length with URLs as 23', () => {
    expect(countWeighted('hello')).toBe(5);
    expect(
      countWeighted(
        'https://example.com/a/very/long/path/that/is/definitely/longer/than/23/characters',
      ),
    ).toBe(23);
  });
  it('counts graphemes and bytes', () => {
    expect(countGraphemes('👩‍👩‍👧‍👦a')).toBe(2);
    expect(countBytes('é')).toBe(2);
  });
  it('applies Bluesky secondary byte cap', () => {
    const m = measureAgainst('é'.repeat(290), DEFAULT_LIMITS.bluesky.text);
    expect(m.count).toBe(290);
    expect(m.over).toBe(false);
    const m2 = measureAgainst('👩‍👩‍👧‍👦'.repeat(150), DEFAULT_LIMITS.bluesky.text);
    expect(m2.count).toBe(150);
    expect(m2.over).toBe(true); // bytes > 3000
  });
});

describe('LinkedIn little-text escaping', () => {
  it('escapes every special character', () => {
    const raw = 'Hi @you (see [this] {and} <that>) #tag *bold* _it_ ~x~ a|b \\ done';
    const esc = escapeLinkedInText(raw);
    expect(esc).toBe(
      'Hi \\@you \\(see \\[this\\] \\{and\\} \\<that\\>\\) \\#tag \\*bold\\* \\_it\\_ \\~x\\~ a\\|b \\\\ done',
    );
    expect(unescapeLinkedInText(esc)).toBe(raw);
  });
  it('leaves plain text alone', () => {
    expect(escapeLinkedInText('Plain text, with punctuation! And a URL https://x.y/z?q=1')).toBe(
      'Plain text, with punctuation! And a URL https://x.y/z?q=1',
    );
  });
});

describe('limits merge', () => {
  it('overrides deeply and can disable video', () => {
    const merged = mergeLimits(DEFAULT_LIMITS, {
      nostr: { text: { max: 1000 } },
      x: { video: null },
    });
    expect(merged.nostr.text.max).toBe(1000);
    expect(merged.nostr.images.max).toBe(DEFAULT_LIMITS.nostr.images.max);
    expect(merged.x.video).toBeNull();
    expect(merged.bluesky).toBe(DEFAULT_LIMITS.bluesky);
  });
});

describe('derivePostStatus', () => {
  it('derives aggregate states', () => {
    expect(derivePostStatus([{ status: 'published' }, { status: 'published' }])).toBe('published');
    expect(derivePostStatus([{ status: 'published' }, { status: 'failed' }])).toBe(
      'partially_published',
    );
    expect(derivePostStatus([{ status: 'failed' }, { status: 'skipped' }])).toBe('failed');
    expect(derivePostStatus([{ status: 'cancelled' }, { status: 'cancelled' }])).toBe('cancelled');
    expect(derivePostStatus([{ status: 'pending' }, { status: 'published' }])).toBe('scheduled');
    expect(derivePostStatus([{ status: 'publishing' }, { status: 'published' }])).toBe(
      'publishing',
    );
    expect(derivePostStatus([{ status: 'needs_auth' }, { status: 'published' }])).toBe(
      'partially_published',
    );
    expect(derivePostStatus([{ status: 'needs_auth' }])).toBe('failed');
    expect(derivePostStatus([{ status: 'needs_auth' }, { status: 'pending' }])).toBe('scheduled');
  });
});
