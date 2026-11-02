/**
 * Blossom media upload (https://github.com/hzrd149/blossom).
 *
 * BUD-01/02: `PUT {server}/upload` with the raw bytes and an `Authorization: Nostr <base64 event>`
 * header, where the event is kind 24242 with tags `t=upload`, `x=<sha256>`, `expiration=<unix>`.
 * The server answers with a blob descriptor `{ url, sha256, size, type, uploaded }`.
 *
 * BUD-04: `PUT {mirror}/mirror` with JSON `{ url }` asks another server to fetch and keep a copy.
 * Mirrors are best-effort: failures are logged, never fatal.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Logger, MediaRef } from '@poster/core';
import { PosterError } from '@poster/core';
import { expectOk, fetchWithTimeout, readJson } from '../http.js';

export const BLOSSOM_AUTH_KIND = 24242;
const AUTH_TTL_SECONDS = 600;

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded?: number;
}

export interface BlossomUploadResult {
  /** Primary URL plus any mirrors that confirmed the copy. */
  urls: string[];
  descriptor: BlobDescriptor;
}

/** Build the base64-encoded kind 24242 authorization event for one action. */
export function buildBlossomAuth(
  sk: Uint8Array,
  action: 'upload' | 'mirror' | 'delete' | 'list',
  opts: { sha256?: string; content?: string; nowSeconds?: number } = {},
): string {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ['t', action],
    ['expiration', String(now + AUTH_TTL_SECONDS)],
  ];
  if (opts.sha256) tags.push(['x', opts.sha256]);
  const event = finalizeEvent(
    {
      kind: BLOSSOM_AUTH_KIND,
      created_at: now,
      tags,
      content: opts.content ?? `${action[0]?.toUpperCase()}${action.slice(1)}`,
    },
    sk,
  );
  return Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
}

export interface BlossomClientOptions {
  primary: string;
  mirrors: string[];
  logger: Logger;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Upload one media file to the primary server, then mirror it. Returns all URLs that hold the blob.
 */
export async function uploadToBlossom(
  media: MediaRef,
  sk: Uint8Array,
  opts: BlossomClientOptions,
): Promise<BlossomUploadResult> {
  const bytes = await readFile(media.path);
  const name = basename(media.path);
  const primary = stripSlash(opts.primary);
  const auth = buildBlossomAuth(sk, 'upload', { sha256: media.sha256, content: `Upload ${name}` });

  const res = await fetchWithTimeout(`${primary}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: `Nostr ${auth}`,
      'Content-Type': media.mime,
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal: opts.signal,
  });
  await expectOk(res, { service: `Blossom (${primary})`, authErrorCode: 'UPSTREAM_ERROR' });
  const descriptor = await readJson<BlobDescriptor>(res, 'Blossom');
  if (!descriptor || typeof descriptor.url !== 'string') {
    throw new PosterError('UPSTREAM_ERROR', `Blossom (${primary}) returned no blob descriptor`, {
      retryable: true,
    });
  }
  if (descriptor.sha256 && descriptor.sha256 !== media.sha256) {
    throw new PosterError(
      'UPSTREAM_ERROR',
      `Blossom (${primary}) stored a blob with a different hash (${descriptor.sha256})`,
      {
        retryable: false,
      },
    );
  }

  const urls = [descriptor.url];
  for (const mirror of opts.mirrors) {
    const m = stripSlash(mirror);
    if (m === primary) continue;
    try {
      const mirrorAuth = buildBlossomAuth(sk, 'upload', {
        sha256: media.sha256,
        content: `Mirror ${name}`,
      });
      const mr = await fetchWithTimeout(`${m}/mirror`, {
        method: 'PUT',
        headers: { Authorization: `Nostr ${mirrorAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: descriptor.url }),
        timeoutMs: 60_000,
        signal: opts.signal,
      });
      if (mr.ok) {
        const d = await readJson<BlobDescriptor | undefined>(mr, 'Blossom mirror').catch(
          () => undefined,
        );
        urls.push(d?.url ?? `${m}/${media.sha256}`);
      } else {
        opts.logger.warn({ mirror: m, status: mr.status }, 'Blossom mirror refused the blob');
      }
    } catch (err) {
      opts.logger.warn(
        { mirror: m, err: err instanceof Error ? err.message : String(err) },
        'Blossom mirror failed',
      );
    }
  }
  return { urls, descriptor };
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
