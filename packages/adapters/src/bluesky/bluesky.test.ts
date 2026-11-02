import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  type AccountPatch,
  type AccountState,
  type MediaRef,
  type PublishCtx,
  type RenderedPost,
} from '@poster/core';
import { BSKY_SERVICE, createBlueskyAdapter, mapBlueskyError } from './index.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const DID = 'did:plc:test123';
const HANDLE = 'tester.bsky.social';
const session = {
  accessJwt: 'access-1',
  refreshJwt: 'refresh-1',
  handle: HANDLE,
  did: DID,
  emailConfirmed: true,
  active: true,
};
// Lexicon validation requires syntactically valid CIDs in responses.
const CIDS = [
  'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a',
  'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
  'bafyreib2rxk3rh6kzwq6zlq3f3lnu2zxkfqzmpcnlqbzjqfvbpjbxcgpiq',
];
const BLOB_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const cid = (n: number) => CIDS[(n - 1) % CIDS.length] as string;

const account: AccountState = {
  network: 'bluesky',
  status: 'connected',
  handle: HANDLE,
  secrets: { identifier: HANDLE, appPassword: 'aaaa-bbbb-cccc-dddd', session },
  meta: { did: DID, handle: HANDLE, emailConfirmed: true, pdsUrl: BSKY_SERVICE },
  browserProfileDir: null,
  proxy: null,
};

function ctx(overrides: Partial<PublishCtx> = {}): PublishCtx {
  return {
    logger,
    settings: DEFAULT_SETTINGS,
    limits: DEFAULT_LIMITS.bluesky,
    dataDir: '/tmp',
    debugDir: '/tmp',
    attemptKey: 'a1',
    account,
    updateAccount: async () => {},
    cacheMediaUrls: async () => {},
    ...overrides,
  };
}

function post(parts: string[], media: MediaRef[][] = []): RenderedPost {
  return {
    postId: 'p',
    targetId: 't',
    network: 'bluesky',
    parts: parts.map((text, i) => ({ text, media: media[i] ?? [] })),
    scheduledAtUtc: Date.now(),
    thread: parts.length > 1,
  };
}

const X = `${BSKY_SERVICE}/xrpc`;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Default happy-path handlers. `resumeSession` in @atproto/api forces a `refreshSession` call
 * with the refresh JWT; we answer with rotated tokens, so every publish uses `access-1b`.
 */
function happyHandlers(records: Record<string, unknown>[], blobs: number[] = []) {
  let n = 0;
  return [
    http.post(`${X}/com.atproto.server.refreshSession`, ({ request }) => {
      if (request.headers.get('authorization') !== `Bearer ${session.refreshJwt}`) {
        return HttpResponse.json(
          { error: 'ExpiredToken', message: 'Token has expired' },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        accessJwt: 'access-1b',
        refreshJwt: 'refresh-1b',
        handle: HANDLE,
        did: DID,
        active: true,
      });
    }),
    http.get(`${X}/com.atproto.server.getSession`, () =>
      HttpResponse.json({ handle: HANDLE, did: DID, emailConfirmed: true, active: true }),
    ),
    http.post(`${X}/com.atproto.repo.uploadBlob`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer access-1b');
      blobs.push((await request.arrayBuffer()).byteLength);
      return HttpResponse.json({
        blob: {
          $type: 'blob',
          ref: { $link: BLOB_CID },
          mimeType: request.headers.get('content-type'),
          size: blobs[blobs.length - 1],
        },
      });
    }),
    http.post(`${X}/com.atproto.repo.createRecord`, async ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer access-1b');
      const body = (await request.json()) as {
        record: Record<string, unknown>;
        repo: string;
        collection: string;
      };
      expect(body.repo).toBe(DID);
      expect(body.collection).toBe('app.bsky.feed.post');
      records.push(body.record);
      n++;
      return HttpResponse.json({ uri: `at://${DID}/app.bsky.feed.post/rkey${n}`, cid: cid(n) });
    }),
  ];
}

describe('Bluesky adapter', () => {
  const adapter = createBlueskyAdapter();

  it('resumes the stored session, persists rotated tokens, detects link facets and returns the post URL', async () => {
    const records: Record<string, unknown>[] = [];
    const patches: AccountPatch[] = [];
    server.use(...happyHandlers(records));
    const result = await adapter.publish(
      post(['Check https://example.com/page now']),
      ctx({ updateAccount: async (p) => void patches.push(p) }),
    );
    const saved = patches.find((p) => p.secrets)?.secrets as
      { session: { accessJwt: string; refreshJwt: string }; appPassword: string } | undefined;
    expect(saved?.session).toMatchObject({ accessJwt: 'access-1b', refreshJwt: 'refresh-1b' });
    expect(saved?.appPassword).toBe('aaaa-bbbb-cccc-dddd');
    expect(result.remoteIds).toEqual([`at://${DID}/app.bsky.feed.post/rkey1`]);
    expect(result.url).toBe(`https://bsky.app/profile/${HANDLE}/post/rkey1`);
    const rec = records[0] as {
      text: string;
      facets?: { features: { $type: string; uri?: string }[] }[];
      createdAt: string;
    };
    expect(rec.text).toBe('Check https://example.com/page now');
    expect(rec.facets?.[0]?.features[0]).toMatchObject({
      $type: 'app.bsky.richtext.facet#link',
      uri: 'https://example.com/page',
    });
    expect(rec.createdAt).toBeTruthy();
  });

  it('threads parts with reply.root / reply.parent strong refs', async () => {
    const records: Record<string, unknown>[] = [];
    server.use(...happyHandlers(records));
    const result = await adapter.publish(post(['one', 'two', 'three']), ctx());
    expect(result.remoteIds).toHaveLength(3);
    expect(records[0]).not.toHaveProperty('reply');
    expect((records[1] as { reply: unknown }).reply).toEqual({
      root: { uri: `at://${DID}/app.bsky.feed.post/rkey1`, cid: cid(1) },
      parent: { uri: `at://${DID}/app.bsky.feed.post/rkey1`, cid: cid(1) },
    });
    expect((records[2] as { reply: unknown }).reply).toEqual({
      root: { uri: `at://${DID}/app.bsky.feed.post/rkey1`, cid: cid(1) },
      parent: { uri: `at://${DID}/app.bsky.feed.post/rkey2`, cid: cid(2) },
    });
  });

  it('uploads images as blobs and embeds them with alt text and aspect ratio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bsky-'));
    const p1 = join(dir, '1.png');
    await writeFile(p1, Buffer.alloc(5, 1));
    const img: MediaRef = {
      id: 'm1',
      kind: 'image',
      path: p1,
      mime: 'image/png',
      bytes: 5,
      sha256: 'x',
      width: 40,
      height: 30,
      altText: 'cat',
    };
    const records: Record<string, unknown>[] = [];
    const blobs: number[] = [];
    server.use(...happyHandlers(records, blobs));
    await adapter.publish(post(['pic'], [[img]]), ctx());
    expect(blobs).toEqual([5]);
    const embed = (
      records[0] as { embed: { $type: string; images: { alt: string; aspectRatio: unknown }[] } }
    ).embed;
    expect(embed.$type).toBe('app.bsky.embed.images');
    expect(embed.images[0]?.alt).toBe('cat');
    expect(embed.images[0]?.aspectRatio).toEqual({ width: 40, height: 30 });
  });

  it('logs in again with the app password when the stored session is rejected, and persists it', async () => {
    const records: Record<string, unknown>[] = [];
    const patches: AccountPatch[] = [];
    let logins = 0;
    server.use(
      http.get(`${X}/com.atproto.server.getSession`, () =>
        HttpResponse.json({ error: 'ExpiredToken', message: 'expired' }, { status: 400 }),
      ),
      http.post(`${X}/com.atproto.server.refreshSession`, () =>
        HttpResponse.json({ error: 'ExpiredToken', message: 'expired' }, { status: 400 }),
      ),
      http.post(`${X}/com.atproto.server.createSession`, async ({ request }) => {
        logins++;
        const body = (await request.json()) as { identifier: string; password: string };
        expect(body).toEqual({ identifier: HANDLE, password: 'aaaa-bbbb-cccc-dddd' });
        return HttpResponse.json({
          accessJwt: 'access-2',
          refreshJwt: 'refresh-2',
          handle: HANDLE,
          did: DID,
          emailConfirmed: true,
          active: true,
        });
      }),
      http.post(`${X}/com.atproto.repo.createRecord`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer access-2');
        records.push(((await request.json()) as { record: Record<string, unknown> }).record);
        return HttpResponse.json({ uri: `at://${DID}/app.bsky.feed.post/r`, cid: cid(1) });
      }),
    );
    await adapter.publish(post(['hi']), ctx({ updateAccount: async (p) => void patches.push(p) }));
    expect(logins).toBe(1);
    expect(records).toHaveLength(1);
    const saved = patches.find((p) => p.secrets)?.secrets as
      { session: { accessJwt: string } } | undefined;
    expect(saved?.session.accessJwt).toBe('access-2');
  });

  it('maps rate limits and auth failures to stable codes', async () => {
    // Earlier handlers win in msw, so the 429 override goes first.
    server.use(
      http.post(`${X}/com.atproto.repo.createRecord`, () =>
        HttpResponse.json({ error: 'RateLimitExceeded', message: 'slow' }, { status: 429 }),
      ),
      ...happyHandlers([]),
    );
    await expect(adapter.publish(post(['x']), ctx())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    server.use(
      http.get(`${X}/com.atproto.server.getSession`, () =>
        HttpResponse.json({ error: 'ExpiredToken' }, { status: 400 }),
      ),
      http.post(`${X}/com.atproto.server.refreshSession`, () =>
        HttpResponse.json({ error: 'ExpiredToken' }, { status: 400 }),
      ),
      http.post(`${X}/com.atproto.server.createSession`, () =>
        HttpResponse.json(
          { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
          { status: 401 },
        ),
      ),
    );
    await expect(adapter.publish(post(['x']), ctx())).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });

    expect(mapBlueskyError({ status: 500, error: 'InternalServerError' }, 'x')).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
    expect(mapBlueskyError({ status: 400, error: 'InvalidRequest' }, 'x')).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: false,
    });
  });

  it('validate blocks video when the email is unverified', () => {
    const video: MediaRef = {
      id: 'v',
      kind: 'video',
      path: '/v.mp4',
      mime: 'video/mp4',
      bytes: 10,
      sha256: 'y',
      durationMs: 1000,
    };
    const unverified: AccountState = {
      ...account,
      meta: { ...account.meta, emailConfirmed: false },
    };
    const issues = adapter.validate(post(['v'], [[video]]), unverified, ctx());
    expect(issues.some((i) => i.code === 'EMAIL_UNVERIFIED' && i.level === 'error')).toBe(true);
    expect(
      adapter
        .validate(post(['v'], [[video]]), account, ctx())
        .some((i) => i.code === 'EMAIL_UNVERIFIED'),
    ).toBe(false);
  });

  it('connect logs in, stores the session and warns about unverified email', async () => {
    if (adapter.connect.kind !== 'credentials') throw new Error('expected credentials');
    server.use(
      http.post(`${X}/com.atproto.server.createSession`, () =>
        HttpResponse.json({
          accessJwt: 'a',
          refreshJwt: 'r',
          handle: HANDLE,
          did: DID,
          emailConfirmed: false,
          active: true,
        }),
      ),
    );
    const res = await adapter.connect.connect(
      { identifier: `@${HANDLE}`, appPassword: 'aaaa-bbbb-cccc-dddd' },
      ctx(),
    );
    expect(res.handle).toBe(HANDLE);
    expect(res.meta).toMatchObject({ did: DID, handle: HANDLE, emailConfirmed: false });
    expect((res.secrets as { session: { accessJwt: string } }).session.accessJwt).toBe('a');
    expect(res.warnings?.join(' ')).toMatch(/not verified/);
    const status = await adapter.connectionStatus({ ...account, meta: res.meta }, ctx());
    expect(status.connected).toBe(true);
    expect(status.warnings.join(' ')).toMatch(/Email not verified/);
  });
});
