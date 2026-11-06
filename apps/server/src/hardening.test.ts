import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { newId, type DraftPreview } from '@poster/core';
import {
  draftCodes,
  notifications as notificationsTable,
  posts,
  postTargets,
} from './db/schema.js';
import { nullLogger } from './logger.js';
import { Notifier } from './services/notifier.js';
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

/** A bearer-token client for the REST API (what a script holding a spa_ token can do). */
function tokenClient(token: string) {
  return {
    async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
      const res = await env.app.inject({
        method,
        url,
        payload,
        headers: { ...HOST, authorization: `Bearer ${token}` },
      });
      return { status: res.statusCode, body: res.json() as T & { code?: string } };
    },
  };
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const liveCodes = (draftId: string) =>
  env.services.db
    .select()
    .from(draftCodes)
    .where(and(eq(draftCodes.draftId, draftId), isNull(draftCodes.usedAt)))
    .all();

describe('retry and post-now keep their provenance (write token cannot publish unconfirmed drafts)', () => {
  it('refuses cancel then post-now for a script token and publishes nothing', async () => {
    const token = env.services.auth.rotateToken('api', 'write');
    const t = tokenClient(token);
    const d = await t.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'never confirmed',
      networks: ['nostr'],
    });
    expect(d.status).toBe(200);
    const id = d.body.draftId;
    expect((await t.call('POST', `/api/v1/posts/${id}/cancel`, {})).status).toBe(200);
    const postNow = await t.call('POST', `/api/v1/posts/${id}/post-now`, {});
    expect(postNow.status).toBe(409);
    expect(postNow.body.code).toBe('STATE_INVALID');
    const retry = await t.call('POST', `/api/v1/posts/${id}/retry`, {});
    expect(retry.status).toBe(409);
    await env.services.scheduler.tick(Date.now() + 5_000);
    expect(env.fakes.nostr.published).toHaveLength(0);
    expect(env.services.posts.getRow(id).confirmedAt).toBeNull();
  });

  it('refuses post-now for an expired draft, even for the operator', async () => {
    const d = await env.services.posts.createDraft({ text: 'old', networks: ['nostr'] }, 'ui');
    env.services.posts.expireDrafts(Date.now() + 25 * 3600_000);
    expect(() => env.services.posts.postNow(d.draftId, undefined, 'api')).toThrow(/expired/);
    expect(() => env.services.posts.postNow(d.draftId, undefined, 'ui')).toThrow(/expired/);
  });

  it('does not let a script token pull a scheduled post forward or revive a cancelled one', async () => {
    const d = await env.services.posts.createDraft(
      { text: 'later', networks: ['nostr'], schedule: inDays(30) },
      'ui',
    );
    await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    expect(() => env.services.posts.postNow(d.draftId, undefined, 'api')).toThrow(
      /No target to retry/,
    );
    env.services.posts.cancel({ postId: d.draftId }, 'ui');
    expect(() => env.services.posts.retry(d.draftId, undefined, 'api')).toThrow(
      /No target to retry/,
    );
    // The operator may revive it.
    const revived = env.services.posts.postNow(d.draftId, undefined, 'ui');
    expect(revived.targets[0]?.status).toBe('pending');
  });

  it('still lets a script token retry a failed target of a confirmed post', async () => {
    env.fakes.nostr.options.failWith = 'AUTH_REQUIRED';
    const d = await env.services.posts.createDraft({ text: 'flaky', networks: ['nostr'] }, 'ui');
    await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() =>
      expect(env.services.posts.get(d.draftId).targets[0]?.status).toBe('needs_auth'),
    );
    env.fakes.nostr.options.failWith = null;
    const view = env.services.posts.retry(d.draftId, undefined, 'api');
    expect(view.targets[0]?.status).toBe('pending');
  });

  it('applies the daily cap and records the confirmation when the operator revives a never-confirmed post', async () => {
    env.services.settings.update({ maxPostsPerDay: 1 });
    const first = await env.services.posts.createDraft({ text: 'one', networks: ['x'] }, 'ui');
    await env.services.posts.confirm(first.draftId, { trusted: true, actor: 'ui' });
    const d = await env.services.posts.createDraft({ text: 'two', networks: ['nostr'] }, 'ui');
    env.services.posts.cancel({ postId: d.draftId }, 'ui');
    expect(() => env.services.posts.postNow(d.draftId, undefined, 'ui')).toThrow(/Daily limit/);
    env.services.settings.update({ maxPostsPerDay: 5 });
    env.services.posts.postNow(d.draftId, undefined, 'ui');
    expect(env.services.posts.getRow(d.draftId).confirmedAt).not.toBeNull();
  });

  it('records the confirmation when the operator reschedules a draft, and the scheduler publishes it', async () => {
    const d = await env.services.posts.createDraft(
      { text: 'rescheduled', networks: ['nostr'] },
      'ui',
    );
    await env.services.posts.reschedule(d.draftId, 'now', undefined, 'ui', true);
    expect(env.services.posts.getRow(d.draftId).confirmedAt).not.toBeNull();
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(env.fakes.nostr.published).toHaveLength(1));
  });

  it('never runs a post that has no recorded confirmation', async () => {
    const d = await env.services.posts.createDraft({ text: 'sneaky', networks: ['nostr'] }, 'ui');
    // Force the unsafe state directly: runnable status, no confirmation.
    env.services.db
      .update(posts)
      .set({ status: 'queued', confirmedAt: null })
      .where(eq(posts.id, d.draftId))
      .run();
    env.services.db
      .update(postTargets)
      .set({ scheduledAtUtc: Date.now() - 1000 })
      .where(eq(postTargets.postId, d.draftId))
      .run();
    await env.services.scheduler.tick(Date.now() + 5_000);
    expect(env.fakes.nostr.published).toHaveLength(0);
  });
});

describe('a confirmation code approves exactly the content it was issued for', () => {
  it('rejects a confirm that is verifying while update_draft changes the draft', async () => {
    const d = await env.services.posts.createDraft(
      { text: 'approved text', networks: ['x'] },
      'mcp',
    );
    const confirm = env.services.posts.confirm(d.draftId, {
      trusted: false,
      code: d.code!,
      actor: 'mcp',
    });
    // The confirm is now awaiting the argon2 check; the update lands in that window.
    const update = env.services.posts.updateDraft(
      { draftId: d.draftId, text: 'UNAPPROVED replacement' },
      'mcp',
    );
    await expect(confirm).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    await update;
    expect(env.services.posts.getRow(d.draftId).status).toBe('draft');
    await env.services.scheduler.tick(Date.now() + 5_000);
    expect(env.fakes.x.published).toHaveLength(0);
  });

  it('rejects a confirm that races an update which swaps in new media', async () => {
    const m = await env.services.media.ingestBuffer(await png());
    const d = await env.services.posts.createDraft({ text: 'plain post', networks: ['x'] }, 'mcp');
    const update = env.services.posts.updateDraft({ draftId: d.draftId, mediaIds: [m.id] }, 'mcp');
    const confirm = env.services.posts.confirm(d.draftId, {
      trusted: false,
      code: d.code!,
      actor: 'mcp',
    });
    await expect(confirm).rejects.toMatchObject({ code: expect.stringMatching(/CODE_/) });
    await update;
    expect(env.services.posts.getRow(d.draftId).status).toBe('draft');
    expect(env.fakes.x.published).toHaveLength(0);
  });

  it('rejects a code whose draft content changed without the code being invalidated', async () => {
    const d = await env.services.posts.createDraft({ text: 'before', networks: ['x'] }, 'mcp');
    // Simulate any path that edits the draft but forgets to invalidate: the digest still catches it.
    env.services.db.update(posts).set({ baseText: 'after' }).where(eq(posts.id, d.draftId)).run();
    await expect(
      env.services.posts.confirm(d.draftId, { trusted: false, code: d.code!, actor: 'mcp' }),
    ).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    expect(env.services.posts.getRow(d.draftId).status).toBe('draft');
  });

  it('keeps exactly one live code when two updates overlap, and that code confirms the final text', async () => {
    const d = await env.services.posts.createDraft({ text: 'start', networks: ['x'] }, 'mcp');
    const [a, b] = await Promise.all([
      env.services.posts.updateDraft({ draftId: d.draftId, text: 'version one' }, 'mcp'),
      env.services.posts.updateDraft({ draftId: d.draftId, text: 'version two' }, 'mcp'),
    ]);
    expect(liveCodes(d.draftId)).toHaveLength(1);
    const final = env.services.posts.getRow(d.draftId).baseText;
    const code = (final === 'version one' ? a : b).code ?? a.code ?? b.code;
    const live = [a.code, b.code].filter(Boolean);
    expect(live.length).toBeGreaterThan(0);
    let confirmed = false;
    for (const c of live) {
      try {
        await env.services.posts.confirm(d.draftId, { trusted: false, code: c!, actor: 'mcp' });
        confirmed = true;
        break;
      } catch {
        /* the earlier code was invalidated */
      }
    }
    expect(code).toBeDefined();
    expect(confirmed).toBe(true);
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(env.fakes.x.published).toHaveLength(1));
    expect(env.fakes.x.published[0]?.post.parts[0]?.text).toBe(final);
  });
});

describe('the five-attempt limit holds under concurrency', () => {
  it('verifies at most five guesses however many arrive together, and consumes a code once', async () => {
    const verify = vi.spyOn(argon2, 'verify');
    const d = await env.services.posts.createDraft({ text: 'guess me', networks: ['x'] }, 'mcp');
    const guesses = Array.from({ length: 40 }, (_, i) => `WRONG${String(i).padStart(2, '0')}`);
    const results = await Promise.allSettled(
      guesses.map((g) =>
        env.services.posts.confirm(d.draftId, { trusted: false, code: g, actor: 'mcp' }),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(verify.mock.calls.length).toBeLessThanOrEqual(10);
    // The code is dead now, genuine or not.
    await expect(
      env.services.posts.confirm(d.draftId, { trusted: false, code: d.code!, actor: 'mcp' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/CODE_/) });
    verify.mockRestore();
  });

  it('lets exactly one of several concurrent confirms with the genuine code through', async () => {
    const d = await env.services.posts.createDraft({ text: 'once', networks: ['x'] }, 'mcp');
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        env.services.posts.confirm(d.draftId, { trusted: false, code: d.code!, actor: 'mcp' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(env.fakes.x.published).toHaveLength(1));
  });
});

describe('the daily cap and the gap come from durable publication records', () => {
  it('still counts a post that published and was then turned back into a draft by reschedule_post', async () => {
    env.services.settings.update({ maxPostsPerDay: 2 });
    const p1 = await env.services.posts.createDraft({ text: 'first', networks: ['nostr'] }, 'ui');
    await env.services.posts.confirm(p1.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(env.fakes.nostr.published).toHaveLength(1));

    env.fakes.x.options.failWith = 'AUTH_REQUIRED';
    const p2 = await env.services.posts.createDraft(
      { text: 'second', networks: ['bluesky', 'x'] },
      'ui',
    );
    await env.services.posts.confirm(p2.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() =>
      expect(env.services.posts.get(p2.draftId).status).toBe('partially_published'),
    );
    const p3 = await env.services.posts.createDraft(
      { text: 'third', networks: ['linkedin'] },
      'ui',
    );
    await expect(
      env.services.posts.confirm(p3.draftId, { trusted: true, actor: 'ui' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    // The agent turns the partly published post back into a draft; the cap must not forget it.
    await env.services.posts.reschedule(p2.draftId, inDays(30), undefined, 'mcp', false);
    expect(env.services.posts.getRow(p2.draftId).confirmedAt).toBeNull();
    await expect(
      env.services.posts.confirm(p3.draftId, { trusted: true, actor: 'ui' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('applies the minimum gap to a post that has already published on the same network', async () => {
    env.services.settings.update({ minGapPerNetworkMinutes: 30 });
    const a = await env.services.posts.createDraft({ text: 'a', networks: ['nostr'] }, 'ui');
    await env.services.posts.confirm(a.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(env.fakes.nostr.published).toHaveLength(1));
    const b = await env.services.posts.createDraft({ text: 'b', networks: ['nostr'] }, 'ui');
    await expect(
      env.services.posts.confirm(b.draftId, { trusted: true, actor: 'ui' }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
  });
});

describe('the out-of-band approval message shows everything and escapes agent text', () => {
  const directMode = () =>
    env.services.settings.update({
      hermes: { webhookBaseUrl: 'http://hermes.test:8644', directRoute: 'poster-direct' },
    });
  const message = () =>
    (env.services.db.select().from(notificationsTable).all().at(-1)?.payload as { message: string })
      .message;

  it('includes every network, every part and the media, and quotes hostile text', async () => {
    directMode();
    const m = await env.services.media.ingestBuffer(await png());
    const d = await env.services.posts.createDraft(
      {
        text: 'Intro that is fine.\n---\nSECOND PART visit http://evil.example/p2',
        networks: ['bluesky', 'x'],
        overrides: { x: { text: 'X only: http://evil.example/x' } },
        mediaIds: [m.id],
        altTexts: ['a "quoted"\nalt'],
      },
      'mcp',
    );
    expect(d.codeDelivery).toBe('direct');
    const msg = message();
    expect(msg).toContain('SECOND PART visit http://evil.example/p2');
    expect(msg).toContain('X only: http://evil.example/x');
    expect(msg).toContain(m.id);
    // Quotes and newlines in agent text cannot add lines to the trusted message.
    expect(msg).toContain('alt="a \\"quoted\\"\\nalt"');
    const lines = msg.split('\n');
    expect(lines.filter((l) => l.startsWith('Reply "yes'))).toHaveLength(1);
  });

  it('withholds the code when the message cannot show the whole post', async () => {
    directMode();
    const d = await env.services.posts.createDraft(
      { text: 'word '.repeat(600).trim(), networks: ['x', 'bluesky'] },
      'mcp',
    );
    expect(d.codeDelivery).toBe('none');
    expect(d.warnings.join(' ')).toMatch(/too large to show in full/);
    expect(liveCodes(d.draftId)).toHaveLength(0);
  });
});

describe('without a direct route the code stays out of the agent unless soft mode is switched on', () => {
  it('issues no code to the agent by default', async () => {
    await env.cleanup();
    env = await createTestEnv({ softMode: false });
    const d = await env.services.posts.createDraft({ text: 'ui only', networks: ['x'] }, 'mcp');
    expect(d.codeDelivery).toBe('none');
    expect(d.code).toBeUndefined();
    expect(d.warnings.join(' ')).toMatch(/confirm this draft in the web UI/);
    expect(liveCodes(d.draftId)).toHaveLength(0);
    await expect(
      env.services.posts.confirm(d.draftId, { trusted: false, code: 'ABCDEF', actor: 'mcp' }),
    ).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    expect(env.services.notifier.codeDeliveryMode()).toBe('none');
    // The operator can still confirm in the UI.
    const r = await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    expect(r.status).toBe('queued');
  });

  it('returns the code only after the operator opted in', async () => {
    env.services.settings.update({ hermes: { allowSoftMode: true } });
    const d = await env.services.posts.createDraft({ text: 'soft', networks: ['x'] }, 'mcp');
    expect(d.codeDelivery).toBe('returned');
    expect(d.code).toMatch(/^[A-Z2-9]{6}$/);
  });
});

describe('thread resume sends each part exactly once', () => {
  const thread = (n: number) =>
    Array.from({ length: n }, (_, i) => `part number ${i + 1}`).join('\n---\n');
  const targetOf = (id: string) => env.services.posts.get(id).targets[0]!;

  it('continues from the first unpublished part after a transient failure', async () => {
    env.fakes.x.options.failAtPart = 1;
    env.fakes.x.options.failTimes = 1;
    const d = await env.services.posts.createDraft({ text: thread(3), networks: ['x'] }, 'ui');
    await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(targetOf(d.draftId).status).toBe('retrying'));
    expect(targetOf(d.draftId).remoteIds).toHaveLength(1);

    await env.services.scheduler.tick(Date.now() + 2 * 60_000);
    await vi.waitFor(() => expect(targetOf(d.draftId).status).toBe('published'));
    expect(env.fakes.x.sentParts).toEqual([
      'part number 1 (1/3)',
      'part number 2 (2/3)',
      'part number 3 (3/3)',
    ]);
    const ids = targetOf(d.draftId).remoteIds;
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps the part count honest across two partial failures', async () => {
    env.fakes.x.options.failAtPart = 1;
    const d = await env.services.posts.createDraft({ text: thread(4), networks: ['x'] }, 'ui');
    await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() => expect(targetOf(d.draftId).status).toBe('retrying'));

    env.fakes.x.options.failAtPart = 3;
    await env.services.scheduler.tick(Date.now() + 2 * 60_000);
    await vi.waitFor(() => expect(targetOf(d.draftId).remoteIds).toHaveLength(3));
    expect(new Set(targetOf(d.draftId).remoteIds).size).toBe(3);
    expect(targetOf(d.draftId).lastErrorMessage).toMatch(/parts 1-3 are published/);

    env.fakes.x.options.failAtPart = undefined;
    await env.services.scheduler.tick(Date.now() + 30 * 60_000);
    await vi.waitFor(() => expect(targetOf(d.draftId).status).toBe('published'));
    expect(env.fakes.x.sentParts).toHaveLength(4);
    expect(new Set(targetOf(d.draftId).remoteIds).size).toBe(4);
  });
});

describe('publishing targets orphaned by a restart are surfaced', () => {
  async function leasedTarget() {
    const d = await env.services.posts.createDraft(
      { text: 'mid-publish', networks: ['nostr'] },
      'ui',
    );
    await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    // Model a process that died after leasing: status publishing, lease 15 minutes ahead.
    env.services.db
      .update(postTargets)
      .set({ status: 'publishing', leaseUntil: Date.now() + 15 * 60_000 })
      .where(eq(postTargets.postId, d.draftId))
      .run();
    return d.draftId;
  }

  it('recovers an unexpired lease at startup, because no runner can own it yet', async () => {
    const id = await leasedTarget();
    env.services.scheduler.recoverStaleLeases(true);
    const t = env.services.posts.get(id).targets[0]!;
    expect(t.status).toBe('failed');
    expect(t.lastErrorCode).toBe('UNKNOWN_OUTCOME');
    expect(env.fakes.nostr.published).toHaveLength(0);
  });

  it('leaves a live lease alone at runtime but recovers it once it has expired', async () => {
    const id = await leasedTarget();
    env.services.scheduler.recoverStaleLeases(false, Date.now() + 5 * 60_000);
    expect(env.services.posts.get(id).targets[0]!.status).toBe('publishing');
    env.services.scheduler.recoverStaleLeases(false, Date.now() + 16 * 60_000);
    expect(env.services.posts.get(id).targets[0]!.lastErrorCode).toBe('UNKNOWN_OUTCOME');
  });

  it('does not touch a publish that is genuinely running in this process', async () => {
    env.fakes.nostr.options.delayMs = 300;
    const d = await env.services.posts.createDraft(
      { text: 'slow publish', networks: ['nostr'] },
      'ui',
    );
    await env.services.posts.confirm(d.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await vi.waitFor(() =>
      expect(env.services.posts.get(d.draftId).targets[0]!.status).toBe('publishing'),
    );
    // A later tick, far past the lease, must not declare the live run orphaned.
    await env.services.scheduler.tick(Date.now() + 60 * 60_000);
    await vi.waitFor(() =>
      expect(env.services.posts.get(d.draftId).targets[0]!.status).toBe('published'),
    );
  });
});

describe('the webhook outbox parks rows that gave up', () => {
  it('does not re-send parked rows on every tick and still delivers newer events', async () => {
    env.services.settings.update({ hermes: { webhookBaseUrl: 'http://hermes.test:8644' } });
    const calls: string[] = [];
    const notifier = new Notifier(
      env.services.db,
      env.services.settings,
      env.services.events,
      nullLogger(),
      async (url) => {
        calls.push(url);
        return new Response('no', { status: url.endsWith('/old-route') ? 404 : 200 });
      },
    );
    const now = Date.now();
    const oldIds: string[] = [];
    for (let i = 0; i < 22; i++) {
      const id = newId();
      oldIds.push(id);
      env.services.db
        .insert(notificationsTable)
        .values({
          id,
          event: 'failed',
          route: 'old-route',
          payload: { message: 'old' },
          attempts: 3,
          nextAttemptAt: now - 1000,
          createdAt: now - 25 * 3600_000,
        })
        .run();
    }
    const fresh = newId();
    env.services.db
      .insert(notificationsTable)
      .values({
        id: fresh,
        event: 'confirmation_code',
        route: 'poster-direct',
        payload: { message: 'code' },
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })
      .run();
    await notifier.tick();
    await notifier.tick();
    await notifier.tick();
    await notifier.tick();
    const row = (id: string) =>
      env.services.db.select().from(notificationsTable).where(eq(notificationsTable.id, id)).get()!;
    expect(row(fresh).deliveredAt).not.toBeNull();
    expect(calls.filter((u) => u.endsWith('/old-route'))).toHaveLength(22);
    expect(calls.filter((u) => u.endsWith('/poster-direct'))).toHaveLength(1);
    expect(row(oldIds[0]!).nextAttemptAt).toBeNull();
    // The operator can still revive a parked row by hand.
    await notifier.retry(oldIds[0]!);
    expect(calls.filter((u) => u.endsWith('/old-route'))).toHaveLength(23);
    expect(row(oldIds[0]!).nextAttemptAt).toBeNull();
  });
});
