import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DraftPreview, PostView } from '@poster/core';
import { createTestEnv, HOST, type TestEnv } from './test-helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const api = (t: TestEnv, auth: { cookie: string; csrf: string }) => ({
  async call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await t.app.inject({
      method,
      url,
      payload,
      headers: { ...HOST, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    });
    return {
      status: res.statusCode,
      body: (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) as T,
    };
  },
});

describe('draft → confirm → publish (REST, UI session, soft code mode)', () => {
  it('rejects requests without a session, with a bad Host, and without CSRF', async () => {
    const anon = await env.app.inject({ method: 'GET', url: '/api/v1/posts', headers: HOST });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['content-type']).toContain('application/problem+json');
    expect(anon.json().code).toBe('UNAUTHORIZED');

    const badHost = await env.app.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: { host: 'evil.example' },
    });
    expect(badHost.statusCode).toBe(421);

    const health = await env.app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'evil.example' },
    });
    expect(health.statusCode).toBe(200);

    const auth = await env.login();
    const noCsrf = await env.app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { ...HOST, cookie: auth.cookie },
      payload: { text: 'x', networks: ['nostr'] },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('creates a draft with a preview and a returned code, confirms, and the scheduler publishes', async () => {
    const auth = await env.login();
    const c = api(env, auth);

    const created = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'Hello from the test suite https://example.com/x',
      networks: ['nostr', 'bluesky'],
      schedule: 'now',
    });
    expect(created.status).toBe(200);
    const preview = created.body;
    expect(preview.status).toBe('draft');
    expect(preview.previews.map((p) => p.network).sort()).toEqual(['bluesky', 'nostr']);
    expect(preview.codeDelivery).toBe('returned');
    expect(preview.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(preview.errors).toEqual([]);
    expect(preview.previews[0]?.parts[0]?.count).toBeGreaterThan(0);

    // Wrong code → CODE_INVALID (via API-token semantics: emulate untrusted by using the service directly).
    await expect(
      env.services.posts.confirm(preview.draftId, { trusted: false, code: 'ZZZZZZ', actor: 'mcp' }),
    ).rejects.toMatchObject({ code: 'CODE_INVALID' });

    const confirmed = await env.services.posts.confirm(preview.draftId, {
      trusted: false,
      code: preview.code!,
      actor: 'mcp',
    });
    expect(confirmed.status).toBe('queued');

    // Code is single-use.
    await expect(
      env.services.posts.confirm(preview.draftId, {
        trusted: false,
        code: preview.code!,
        actor: 'mcp',
      }),
    ).rejects.toMatchObject({ code: 'STATE_INVALID' });

    await env.services.scheduler.tick();
    await waitForInFlight(env);

    const post = await c.call<PostView>('GET', `/api/v1/posts/${preview.draftId}`);
    expect(post.body.status).toBe('published');
    for (const t of post.body.targets) {
      expect(t.status).toBe('published');
      expect(t.publishedUrl).toContain(`https://fake.${t.network}.example/`);
      expect(t.attemptLog?.[0]?.outcome).toBe('published');
    }
    expect(env.fakes.nostr.published).toHaveLength(1);
    expect(env.fakes.bluesky.published).toHaveLength(1);
    expect(env.fakes.x.published).toHaveLength(0);
  });

  it('UI session confirms without a code and schedules in the future', async () => {
    const auth = await env.login();
    const c = api(env, auth);
    const created = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'Scheduled post',
      networks: ['x'],
      schedule: { at: '2027-06-01 09:00', tz: 'Europe/Prague' },
    });
    expect(created.body.schedule.isoUtc).toBe('2027-06-01T07:00:00Z');
    const confirmed = await c.call<{ status: string }>(
      'POST',
      `/api/v1/drafts/${created.body.draftId}/confirm`,
      {},
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('scheduled');
    await env.services.scheduler.tick();
    expect(env.fakes.x.published).toHaveLength(0);

    const list = await c.call<{ items: PostView[] }>(
      'GET',
      '/api/v1/posts?status=scheduled,queued',
    );
    expect(list.body.items.map((p) => p.id)).toContain(created.body.draftId);

    // Reschedule (UI, trusted) and cancel.
    const re = await c.call<PostView>('POST', `/api/v1/posts/${created.body.draftId}/reschedule`, {
      schedule: { at: '2027-06-02 10:00', tz: 'Europe/Prague' },
    });
    expect(re.body.targets[0]?.schedule.isoUtc).toBe('2027-06-02T08:00:00Z');
    const cancelled = await c.call<{ status: string; cancelled: string[] }>(
      'POST',
      `/api/v1/posts/${created.body.draftId}/cancel`,
      {},
    );
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancelled).toEqual(['x']);
  });

  it('splits long text into a thread for X and rejects it for LinkedIn', async () => {
    const auth = await env.login();
    const c = api(env, auth);
    const long = 'This sentence is here to make the text long enough to need a thread. '.repeat(10);
    const r = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: long,
      networks: ['x', 'linkedin'],
    });
    const x = r.body.previews.find((p) => p.network === 'x')!;
    const li = r.body.previews.find((p) => p.network === 'linkedin')!;
    expect(x.thread).toBe(true);
    expect(x.parts.length).toBeGreaterThan(1);
    expect(x.parts[0]?.text.endsWith(`(1/${x.parts.length})`)).toBe(true);
    expect(li.thread).toBe(false);
    expect(li.parts).toHaveLength(1);
    expect(r.body.errors).toEqual([]);

    const tooLong = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'x'.repeat(3100),
      networks: ['linkedin'],
    });
    expect(tooLong.body.errors.some((e) => /LinkedIn/.test(e))).toBe(true);
    expect(tooLong.body.codeDelivery).toBe('none');
    const confirm = await c.call<{ code: string }>(
      'POST',
      `/api/v1/drafts/${tooLong.body.draftId}/confirm`,
      {},
    );
    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe('VALIDATION');
  });

  it('ingests media from the inbox with host-path mapping, rejects traversal, and attaches it', async () => {
    const auth = await env.login();
    const c = api(env, auth);
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#3366ff' },
    })
      .png()
      .toBuffer();
    writeFileSync(join(env.inboxDir, 'photo.png'), png);
    writeFileSync(join(env.dataDir, 'outside.png'), png);

    const up = await c.call<{
      id: string;
      kind: string;
      width: number;
      compatibility: Record<string, { ok: boolean }>;
    }>('POST', '/api/v1/media/from-path', { path: '/host/inbox/photo.png' });
    expect(up.status).toBe(200);
    expect(up.body.kind).toBe('image');
    expect(up.body.width).toBe(64);
    expect(up.body.compatibility.x?.ok).toBe(true);

    const bad = await c.call<{ code: string }>('POST', '/api/v1/media/from-path', {
      path: join(env.dataDir, 'outside.png'),
    });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('FORBIDDEN');
    const trav = await c.call<{ code: string }>('POST', '/api/v1/media/from-path', {
      path: `/host/inbox/../${env.dataDir.split('/').pop()}/outside.png`,
    });
    expect([403, 404]).toContain(trav.status);

    const draft = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'with image',
      networks: ['bluesky'],
      mediaIds: [up.body.id],
      altTexts: ['A blue rectangle'],
    });
    expect(draft.body.previews[0]?.parts[0]?.media[0]?.altText).toBe('A blue rectangle');
    expect(draft.body.errors).toEqual([]);

    const thumb = await env.app.inject({
      method: 'GET',
      url: `/api/v1/media/${up.body.id}/preview`,
      headers: { ...HOST, cookie: auth.cookie },
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/jpeg');
  });

  it('enforces the daily post limit and the per-network minimum gap', async () => {
    const auth = await env.login();
    const c = api(env, auth);
    await c.call('PUT', '/api/v1/settings', { maxPostsPerDay: 1, minGapPerNetworkMinutes: 5 });
    const a = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'first',
      networks: ['nostr'],
      schedule: { at: '2027-06-01 09:00', tz: 'Europe/Prague' },
    });
    expect((await c.call('POST', `/api/v1/drafts/${a.body.draftId}/confirm`, {})).status).toBe(200);
    const b = await c.call<DraftPreview>('POST', '/api/v1/drafts', {
      text: 'second',
      networks: ['nostr'],
      schedule: { at: '2027-06-01 09:02', tz: 'Europe/Prague' },
    });
    const limited = await c.call<{ code: string }>(
      'POST',
      `/api/v1/drafts/${b.body.draftId}/confirm`,
      {},
    );
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    await c.call('PUT', '/api/v1/settings', { maxPostsPerDay: 10 });
    const gap = await c.call<{ code: string }>(
      'POST',
      `/api/v1/drafts/${b.body.draftId}/confirm`,
      {},
    );
    expect(gap.status).toBe(400);
    expect(gap.body.code).toBe('SCHEDULE_INVALID');
  });
});

describe('scheduler failure handling', () => {
  it('retries transient errors with backoff, then succeeds', async () => {
    env.fakes.nostr.options.failWith = 'UPSTREAM_ERROR';
    env.fakes.nostr.options.failTimes = 1;
    const p = await env.services.posts.createDraft(
      { text: 'retry me', networks: ['nostr'], thread: 'auto' },
      'ui',
    );
    await env.services.posts.confirm(p.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await waitForInFlight(env);
    let post = env.services.posts.get(p.draftId);
    expect(post.targets[0]?.status).toBe('retrying');
    expect(post.targets[0]?.attempts).toBe(1);
    expect(post.targets[0]?.nextAttemptAt).toBeGreaterThan(Date.now());
    // Simulate time passing.
    await env.services.scheduler.tick(post.targets[0]!.nextAttemptAt! + 1);
    await waitForInFlight(env);
    post = env.services.posts.get(p.draftId);
    expect(post.status).toBe('published');
    expect(post.targets[0]?.attempts).toBe(2);
  });

  it('marks AUTH_REQUIRED targets as needs_auth and the account as needs_auth', async () => {
    env.fakes.x.options.failWith = 'AUTH_REQUIRED';
    const p = await env.services.posts.createDraft(
      { text: 'auth', networks: ['x', 'nostr'], thread: 'auto' },
      'ui',
    );
    await env.services.posts.confirm(p.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await waitForInFlight(env);
    const post = env.services.posts.get(p.draftId);
    expect(post.status).toBe('partially_published');
    expect(post.targets.find((t) => t.network === 'x')?.status).toBe('needs_auth');
    expect(post.targets.find((t) => t.network === 'nostr')?.status).toBe('published');
    expect(env.services.accounts.getState('x')?.status).toBe('needs_auth');
  });

  it('does not retry UNKNOWN_OUTCOME and keeps published thread parts on partial failure', async () => {
    env.fakes.bluesky.options.failWith = 'UNKNOWN_OUTCOME';
    env.fakes.x.options.failAtPart = 1;
    const long = 'Another fairly long sentence that pushes the text over the limit for X. '.repeat(
      8,
    );
    const p = await env.services.posts.createDraft(
      { text: long, networks: ['bluesky', 'x'], thread: 'auto' },
      'ui',
    );
    await env.services.posts.confirm(p.draftId, { trusted: true, actor: 'ui' });
    await env.services.scheduler.tick();
    await waitForInFlight(env);
    const post = env.services.posts.get(p.draftId);
    const b = post.targets.find((t) => t.network === 'bluesky')!;
    expect(b.status).toBe('failed');
    expect(b.lastErrorCode).toBe('UNKNOWN_OUTCOME');
    const x = post.targets.find((t) => t.network === 'x')!;
    expect(x.status).toBe('retrying');
    expect(x.remoteIds).toHaveLength(1);
    expect(x.lastErrorMessage).toMatch(/parts 1-1 are published/);
  });

  it('fails a target that is past the missed window instead of posting late', async () => {
    const p = await env.services.posts.createDraft(
      {
        text: 'late',
        networks: ['nostr'],
        schedule: { at: '2027-06-01 09:00', tz: 'Europe/Prague' },
        thread: 'auto',
      },
      'ui',
    );
    await env.services.posts.confirm(p.draftId, { trusted: true, actor: 'ui' });
    const due = env.services.posts.get(p.draftId).targets[0]!.schedule.atUtcMs;
    await env.services.scheduler.tick(due + 60 * 60_000); // one hour late, window is 30 min
    await waitForInFlight(env);
    const post = env.services.posts.get(p.draftId);
    expect(post.targets[0]?.status).toBe('failed');
    expect(post.targets[0]?.lastErrorCode).toBe('MISSED_WINDOW');
    expect(env.fakes.nostr.published).toHaveLength(0);
    // Post now re-queues it.
    env.services.posts.postNow(p.draftId, undefined, 'ui');
    await env.services.scheduler.tick();
    await waitForInFlight(env);
    expect(env.services.posts.get(p.draftId).status).toBe('published');
  });

  it('turns stale publishing leases into UNKNOWN_OUTCOME on startup', async () => {
    const p = await env.services.posts.createDraft(
      { text: 'stale', networks: ['nostr'], thread: 'auto' },
      'ui',
    );
    await env.services.posts.confirm(p.draftId, { trusted: true, actor: 'ui' });
    const { postTargets } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    env.services.db
      .update(postTargets)
      .set({ status: 'publishing', leaseUntil: Date.now() - 1000 })
      .where(eq(postTargets.postId, p.draftId))
      .run();
    env.services.scheduler.recoverStaleLeases();
    const post = env.services.posts.get(p.draftId);
    expect(post.targets[0]?.status).toBe('failed');
    expect(post.targets[0]?.lastErrorCode).toBe('UNKNOWN_OUTCOME');
  });

  it('expires unconfirmed drafts', async () => {
    const p = await env.services.posts.createDraft(
      { text: 'expire', networks: ['nostr'], thread: 'auto' },
      'ui',
    );
    await env.services.scheduler.tick(Date.now() + 25 * 3600_000);
    expect(env.services.posts.get(p.draftId).status).toBe('expired');
  });
});

describe('notifier', () => {
  it('delivers signed webhook events for codes and results when a direct route is configured', async () => {
    env.services.settings.update({
      hermes: { webhookBaseUrl: 'http://hermes.test:8644', directRoute: 'poster-direct' },
    });
    env.services.settings.setSecret('hermes.webhookSecret', 'shh');
    const p = await env.services.posts.createDraft(
      { text: 'notify', networks: ['nostr'], thread: 'auto' },
      'mcp',
    );
    expect(p.codeDelivery).toBe('direct');
    expect(p.code).toBeUndefined();
    await env.services.notifier.tick();
    const codeCall = env.webhookCalls.find(
      (c) => (c.body as { event: string }).event === 'confirmation_code',
    );
    expect(codeCall).toBeDefined();
    expect(codeCall!.url).toBe('http://hermes.test:8644/webhooks/poster-direct');
    expect(codeCall!.headers['x-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const code = (codeCall!.body as { code: string }).code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect((codeCall!.body as { message: string }).message).toContain(code);

    await env.services.posts.confirm(p.draftId, { trusted: false, code, actor: 'mcp' });
    await env.services.scheduler.tick();
    await waitForInFlight(env);
    await env.services.notifier.tick();
    const published = env.webhookCalls.find(
      (c) => (c.body as { event: string }).event === 'published',
    );
    expect(published).toBeDefined();
    expect((published!.body as { summary: string }).summary).toContain('Posted to Nostr');
    expect(env.services.notifier.list({ undeliveredOnly: true })).toHaveLength(0);
  });

  it('keeps undelivered events with backoff when Hermes is down', async () => {
    const down = await createTestEnv({ webhookStatus: 503 });
    try {
      down.services.settings.update({ hermes: { webhookBaseUrl: 'http://hermes.test:8644' } });
      await down.services.posts.createDraft(
        { text: 'notify', networks: ['nostr'], thread: 'auto' },
        'mcp',
      );
      await down.services.notifier.tick();
      const undelivered = down.services.notifier.list({ undeliveredOnly: true });
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0]?.attempts).toBe(1);
      expect(undelivered[0]?.lastError).toContain('503');
      expect(undelivered[0]?.nextAttemptAt).toBeGreaterThan(Date.now());
    } finally {
      await down.cleanup();
    }
  });
});

async function waitForInFlight(t: TestEnv): Promise<void> {
  // The scheduler runs targets asynchronously; stop() awaits them without clearing the timer when none is set.
  await t.services.scheduler.stop();
}
