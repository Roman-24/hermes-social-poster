import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  PosterError,
  type AccountState,
  type MediaRef,
  type PublishCtx,
  type RenderedPost,
} from '@poster/core';
import { LINKEDIN_API, LINKEDIN_VERSION, buildPostBody, createLinkedInAdapter } from './index.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const account: AccountState = {
  network: 'linkedin',
  status: 'connected',
  handle: 'Test Person',
  secrets: { accessToken: 'tok-secret', expiresAt: Date.now() + 30 * 86_400_000 },
  meta: {
    personUrn: 'urn:li:person:abc',
    name: 'Test Person',
    expiresAt: Date.now() + 30 * 86_400_000,
  },
  browserProfileDir: null,
  proxy: null,
};

function ctx(overrides: Partial<PublishCtx> = {}): PublishCtx {
  return {
    logger,
    settings: DEFAULT_SETTINGS,
    limits: DEFAULT_LIMITS.linkedin,
    dataDir: '/tmp',
    debugDir: '/tmp',
    attemptKey: 'att-1',
    account,
    updateAccount: async () => {},
    cacheMediaUrls: async () => {},
    ...overrides,
  };
}

function post(text: string, media: MediaRef[] = []): RenderedPost {
  return {
    postId: 'p1',
    targetId: 't1',
    network: 'linkedin',
    parts: [{ text, media }],
    scheduledAtUtc: Date.now(),
    thread: false,
  };
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const adapter = createLinkedInAdapter({
  getClientCredentials: async () => ({ clientId: 'cid', clientSecret: 'csec' }),
  timing: { videoSettleMs: 0, videoRetryBackoffMs: [0, 0], imagePollIntervalMs: 0 },
});

describe('LinkedIn adapter', () => {
  it('escapes little-text specials and sends the versioned headers', async () => {
    let received: { headers: Headers; body: Record<string, unknown> } | undefined;
    server.use(
      http.post(`${LINKEDIN_API}/rest/posts`, async ({ request }) => {
        received = {
          headers: request.headers,
          body: (await request.json()) as Record<string, unknown>,
        };
        return new HttpResponse(null, {
          status: 201,
          headers: { 'x-restli-id': 'urn:li:share:123' },
        });
      }),
    );
    const result = await adapter.publish(post('Hello @world (test) #tag'), ctx());
    expect(result.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:123');
    expect(result.remoteIds).toEqual(['urn:li:share:123']);
    expect(received?.headers.get('authorization')).toBe('Bearer tok-secret');
    expect(received?.headers.get('linkedin-version')).toBe(LINKEDIN_VERSION);
    expect(received?.headers.get('x-restli-protocol-version')).toBe('2.0.0');
    expect(received?.body.commentary).toBe('Hello \\@world \\(test\\) \\#tag');
    expect(received?.body.author).toBe('urn:li:person:abc');
    expect(received?.body.lifecycleState).toBe('PUBLISHED');
    expect(received?.body.content).toBeUndefined();
  });

  it('uploads an image, waits for AVAILABLE and references the URN', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'li-'));
    const file = join(dir, 'a.png');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const img: MediaRef = {
      id: 'm1',
      kind: 'image',
      path: file,
      mime: 'image/png',
      bytes: 7,
      sha256: 'x',
      altText: 'An image',
    };

    let polls = 0;
    let uploadedBytes = 0;
    let postBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${LINKEDIN_API}/rest/images`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('action')).toBe('initializeUpload');
        return HttpResponse.json({
          value: { uploadUrl: 'https://upload.example/img', image: 'urn:li:image:IMG1' },
        });
      }),
      http.put('https://upload.example/img', async ({ request }) => {
        uploadedBytes = (await request.arrayBuffer()).byteLength;
        return new HttpResponse(null, { status: 201 });
      }),
      http.get(`${LINKEDIN_API}/rest/images/:urn`, () => {
        polls++;
        return HttpResponse.json({ status: polls < 2 ? 'PROCESSING' : 'AVAILABLE' });
      }),
      http.post(`${LINKEDIN_API}/rest/posts`, async ({ request }) => {
        postBody = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, {
          status: 201,
          headers: { 'x-restli-id': 'urn:li:ugcPost:9' },
        });
      }),
    );
    const result = await adapter.publish(post('With image', [img]), ctx());
    expect(uploadedBytes).toBe(7);
    expect(polls).toBe(2);
    expect(postBody?.content).toEqual({ media: { id: 'urn:li:image:IMG1', altText: 'An image' } });
    expect(result.remoteIds).toEqual(['urn:li:ugcPost:9']);
  });

  it('maps 401 to AUTH_REQUIRED and 429 to RATE_LIMITED', async () => {
    server.use(
      http.post(`${LINKEDIN_API}/rest/posts`, () =>
        HttpResponse.json({ message: 'expired' }, { status: 401 }),
      ),
    );
    await expect(adapter.publish(post('x'), ctx())).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });

    server.use(
      http.post(`${LINKEDIN_API}/rest/posts`, () =>
        HttpResponse.json({ message: 'slow down' }, { status: 429 }),
      ),
    );
    const err = await adapter.publish(post('x'), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PosterError);
    expect((err as PosterError).code).toBe('RATE_LIMITED');
    expect((err as PosterError).retryable).toBe(true);
  });

  it('treats 5xx as retryable UPSTREAM_ERROR and other 4xx as non-retryable', async () => {
    server.use(
      http.post(`${LINKEDIN_API}/rest/posts`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 503 }),
      ),
    );
    const e1 = (await adapter.publish(post('x'), ctx()).catch((e: unknown) => e)) as PosterError;
    expect(e1.code).toBe('UPSTREAM_ERROR');
    expect(e1.retryable).toBe(true);

    server.use(
      http.post(`${LINKEDIN_API}/rest/posts`, () =>
        HttpResponse.json({ message: 'bad commentary' }, { status: 422 }),
      ),
    );
    const e2 = (await adapter.publish(post('x'), ctx()).catch((e: unknown) => e)) as PosterError;
    expect(e2.code).toBe('UPSTREAM_ERROR');
    expect(e2.retryable).toBe(false);
    expect(e2.message).toContain('bad commentary');
  });

  it('fails with UNKNOWN_OUTCOME when the post is accepted without an id header', async () => {
    server.use(
      http.post(`${LINKEDIN_API}/rest/posts`, () => new HttpResponse(null, { status: 201 })),
    );
    await expect(adapter.publish(post('x'), ctx())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
      retryable: false,
    });
  });

  it('refuses to publish without a token or with an expired one', async () => {
    const expired: AccountState = {
      ...account,
      secrets: { accessToken: 't', expiresAt: Date.now() - 1 },
    };
    await expect(adapter.publish(post('x'), ctx({ account: expired }))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    const none: AccountState = { ...account, secrets: null, status: 'disconnected' };
    await expect(adapter.publish(post('x'), ctx({ account: none }))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('validate rejects threads and over-long text', () => {
    const long: RenderedPost = { ...post('a'.repeat(3001)) };
    const issues = adapter.validate(long, account, ctx());
    expect(issues.some((i) => i.code === 'TEXT_TOO_LONG' && i.level === 'error')).toBe(true);
    const thread: RenderedPost = {
      ...post('a'),
      parts: [
        { text: 'a', media: [] },
        { text: 'b', media: [] },
      ],
      thread: true,
    };
    expect(
      adapter.validate(thread, account, ctx()).some((i) => i.code === 'THREADS_UNSUPPORTED'),
    ).toBe(true);
  });

  it('connectionStatus warns before expiry and flags expired tokens', async () => {
    const soon: AccountState = {
      ...account,
      secrets: { accessToken: 't', expiresAt: Date.now() + 1.5 * 86_400_000 },
    };
    const s1 = await adapter.connectionStatus(soon, ctx());
    expect(s1.connected).toBe(true);
    expect(s1.warnings.join(' ')).toMatch(/expires in 2 days/);
    const gone: AccountState = {
      ...account,
      secrets: { accessToken: 't', expiresAt: Date.now() - 1 },
    };
    const s2 = await adapter.connectionStatus(gone, ctx());
    expect(s2.connected).toBe(false);
    expect(s2.status).toBe('needs_auth');
  });

  it('builds the OAuth authorize URL with PKCE and exchanges the code', async () => {
    const flow = adapter.connect;
    if (flow.kind !== 'oauth') throw new Error('expected oauth');
    const url = new URL(
      flow.authorizeUrl({
        redirectUri: 'https://p.ts.net/cb',
        state: 'st',
        codeChallenge: 'ch',
        clientId: 'cid',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://p.ts.net/cb');

    let form: URLSearchParams | undefined;
    server.use(
      http.post('https://www.linkedin.com/oauth/v2/accessToken', async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: 'AT',
          expires_in: 5184000,
          scope: 'openid profile w_member_social',
        });
      }),
      http.get(`${LINKEDIN_API}/v2/userinfo`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer AT');
        return HttpResponse.json({ sub: 'SUB1', name: 'Jane Doe' });
      }),
    );
    const res = await flow.exchangeCode(
      {
        code: 'c',
        redirectUri: 'https://p.ts.net/cb',
        codeVerifier: 'v',
        clientId: 'cid',
        clientSecret: 'cs',
      },
      ctx(),
    );
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code_verifier')).toBe('v');
    expect(res.handle).toBe('Jane Doe');
    expect(res.meta.personUrn).toBe('urn:li:person:SUB1');
    expect((res.secrets as { accessToken: string }).accessToken).toBe('AT');
    expect(res.warnings?.join(' ')).toMatch(/refresh token/);
  });

  it('buildPostBody uses multiImage for several images', () => {
    const body = buildPostBody('urn:li:person:a', 'hi', [
      { kind: 'image', urn: 'urn:li:image:1', altText: 'one' },
      { kind: 'image', urn: 'urn:li:image:2' },
    ]);
    expect(body.content).toEqual({
      multiImage: { images: [{ id: 'urn:li:image:1', altText: 'one' }, { id: 'urn:li:image:2' }] },
    });
  });
});
