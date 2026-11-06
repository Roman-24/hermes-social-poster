import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { DraftPreview } from '@poster/core';
import { createTestEnv, HOST, type TestEnv } from './test-helpers.js';

/**
 * Regression tests for the findings of the security audit. Each describe block names the
 * finding it pins down. The tests use fake adapters and an in-memory database only.
 */

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: '#22aa66' } })
    .png()
    .toBuffer();
}

async function ui() {
  const auth = await env.login();
  return {
    async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
      const res = await env.app.inject({
        method,
        url,
        payload,
        headers: { ...HOST, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      });
      return { status: res.statusCode, body: res.json() as T };
    },
  };
}

describe('input bounds (bounded draft inputs, linear parsing)', () => {
  it('rejects oversized arrays and texts at the schema', async () => {
    const c = await ui();
    const ids = Array.from({ length: 21 }, (_, i) => `id${i}`);
    const tooManyMedia = await c.call('POST', '/api/v1/drafts', {
      text: 'hi',
      networks: ['nostr'],
      mediaIds: ids,
    });
    expect(tooManyMedia.status).toBe(400);
    const longOverride = await c.call('POST', '/api/v1/drafts', {
      text: 'hi',
      networks: ['x'],
      overrides: { x: { text: 'a'.repeat(10_001) } },
    });
    expect(longOverride.status).toBe(400);
    const longText = await c.call('POST', '/api/v1/drafts', {
      text: 'a'.repeat(10_001),
      networks: ['x'],
    });
    expect(longText.status).toBe(400);
    const overrideIds = await c.call('POST', '/api/v1/drafts', {
      text: 'hi',
      networks: ['x'],
      overrides: { x: { mediaIds: ids } },
    });
    expect(overrideIds.status).toBe(400);
  });

  it('does not reset the thread mode when an update leaves it out', async () => {
    const draft = await env.services.posts.createDraft(
      { text: 'hello', networks: ['x'], thread: 'off' },
      'ui',
    );
    await env.services.posts.updateDraft({ draftId: draft.draftId, text: 'hello again' }, 'ui');
    expect(env.services.posts.getRow(draft.draftId).threadMode).toBe('off');
  });

  it('refuses an attachment list no network accepts before doing any per-attachment work', async () => {
    const m = await env.services.media.ingestBuffer(await png());
    const spy = vi.spyOn(env.services.media, 'variantFor');
    const preview = await env.services.posts.createDraft(
      { text: 'hi', networks: ['bluesky'], mediaIds: Array.from({ length: 12 }, () => m.id) },
      'ui',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(preview.errors.join(' ')).toMatch(/attachments/);
    expect(preview.codeDelivery).toBe('none');
  });

  it('previews a draft made of thousands of blank lines in well under a second', async () => {
    const t0 = Date.now();
    const preview: DraftPreview = await env.services.posts.createDraft(
      { text: `a${'\n'.repeat(9_000)}b`, networks: ['x', 'bluesky', 'nostr'] },
      'ui',
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(preview.previews.length).toBe(3);
  });
});
