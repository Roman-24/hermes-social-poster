import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import type { MediaRef } from '@poster/core';
import { BLOSSOM_AUTH_KIND, buildBlossomAuth, uploadToBlossom } from './blossom.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function decodeAuth(header: string | null): Event {
  expect(header).toMatch(/^Nostr /);
  return JSON.parse(Buffer.from((header as string).slice(6), 'base64').toString('utf8')) as Event;
}

describe('Blossom upload', () => {
  it('signs a kind 24242 auth event with t=upload and x=<sha256>, mirrors best-effort', async () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const bytes = Buffer.from('hello blossom');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dir = await mkdtemp(join(tmpdir(), 'blossom-'));
    const path = join(dir, 'pic.png');
    await writeFile(path, bytes);
    const media: MediaRef = {
      id: 'm1',
      kind: 'image',
      path,
      mime: 'image/png',
      bytes: bytes.length,
      sha256,
      width: 10,
      height: 20,
    };

    let uploadAuth: Event | undefined;
    let mirrorBody: unknown;
    let mirrorAuth: Event | undefined;
    server.use(
      http.put('https://blossom.primary.test/upload', async ({ request }) => {
        uploadAuth = decodeAuth(request.headers.get('authorization'));
        expect(request.headers.get('content-type')).toBe('image/png');
        const body = Buffer.from(await request.arrayBuffer());
        expect(body.equals(bytes)).toBe(true);
        return HttpResponse.json({
          url: `https://blossom.primary.test/${sha256}.png`,
          sha256,
          size: bytes.length,
          type: 'image/png',
        });
      }),
      http.put('https://mirror-ok.test/mirror', async ({ request }) => {
        mirrorAuth = decodeAuth(request.headers.get('authorization'));
        mirrorBody = await request.json();
        return HttpResponse.json({
          url: `https://mirror-ok.test/${sha256}.png`,
          sha256,
          size: bytes.length,
        });
      }),
      http.put('https://mirror-down.test/mirror', () =>
        HttpResponse.json({ message: 'nope' }, { status: 500 }),
      ),
    );

    const result = await uploadToBlossom(media, sk, {
      primary: 'https://blossom.primary.test/',
      mirrors: ['https://mirror-ok.test', 'https://mirror-down.test'],
      logger,
    });
    expect(result.urls).toEqual([
      `https://blossom.primary.test/${sha256}.png`,
      `https://mirror-ok.test/${sha256}.png`,
    ]);
    expect(uploadAuth?.kind).toBe(BLOSSOM_AUTH_KIND);
    expect(uploadAuth?.pubkey).toBe(pubkey);
    expect(verifyEvent(uploadAuth as Event)).toBe(true);
    expect(uploadAuth?.tags).toContainEqual(['t', 'upload']);
    expect(uploadAuth?.tags).toContainEqual(['x', sha256]);
    const exp = uploadAuth?.tags.find((t) => t[0] === 'expiration')?.[1];
    expect(Number(exp)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(mirrorBody).toEqual({ url: `https://blossom.primary.test/${sha256}.png` });
    expect(mirrorAuth?.tags).toContainEqual(['x', sha256]);
  });

  it('rejects a descriptor whose hash does not match', async () => {
    const sk = generateSecretKey();
    const bytes = Buffer.from('abc');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dir = await mkdtemp(join(tmpdir(), 'blossom-'));
    const path = join(dir, 'a.bin');
    await writeFile(path, bytes);
    server.use(
      http.put('https://b.test/upload', () =>
        HttpResponse.json({ url: 'https://b.test/zzz', sha256: 'deadbeef', size: 3 }),
      ),
    );
    await expect(
      uploadToBlossom({ id: 'm', kind: 'image', path, mime: 'image/png', bytes: 3, sha256 }, sk, {
        primary: 'https://b.test',
        mirrors: [],
        logger,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
  });

  it('maps a 5xx from the primary to a retryable UPSTREAM_ERROR', async () => {
    const sk = generateSecretKey();
    const dir = await mkdtemp(join(tmpdir(), 'blossom-'));
    const path = join(dir, 'a.bin');
    await writeFile(path, 'abc');
    server.use(http.put('https://b.test/upload', () => new HttpResponse('down', { status: 502 })));
    await expect(
      uploadToBlossom(
        { id: 'm', kind: 'image', path, mime: 'image/png', bytes: 3, sha256: 'x' },
        sk,
        { primary: 'https://b.test', mirrors: [], logger },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });

  it('buildBlossomAuth produces a verifiable event', () => {
    const sk = generateSecretKey();
    const ev = JSON.parse(
      Buffer.from(buildBlossomAuth(sk, 'delete', { sha256: 'ab' }), 'base64').toString(),
    ) as Event;
    expect(ev.kind).toBe(24242);
    expect(ev.tags).toContainEqual(['t', 'delete']);
    expect(verifyEvent(ev)).toBe(true);
  });
});
