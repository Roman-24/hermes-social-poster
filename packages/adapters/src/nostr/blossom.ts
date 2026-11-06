/**
 * Blossom media upload (https://github.com/hzrd149/blossom).
 *
 * BUD-01/02: `PUT {server}/upload` with the raw bytes and an `Authorization: Nostr <base64 event>`
 * header, where the event is kind 24242 with tags `t=upload`, `x=<sha256>`, `expiration=<unix>`.
 * The server answers with a blob descriptor `{ url, sha256, size, type, uploaded }`.
 *
 * BUD-04: `PUT {mirror}/mirror` with JSON `{ url }` asks another server to fetch and keep a copy.
 * Mirrors are best-effort: failures are logged, never fatal.
 *
 * The server's reply is not trusted. The URL that ends up in the signed note is built here from
 * the configured server and the SHA-256 of the exact bytes that were uploaded, and the reply is
 * accepted only if it confirms that same hash.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Logger, MediaRef } from '@poster/core';
import { PosterError } from '@poster/core';
import { expectOk, fetchWithTimeout, readJson, safeText } from '../http.js';

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
  /** Primary URL plus any mirrors that confirmed the copy. Built locally, never taken from a reply. */
  urls: string[];
  /** SHA-256 of the exact bytes that were uploaded; use it for the NIP-92 `x` field. */
  sha256: string;
  descriptor: BlobDescriptor;
}

const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
};

/** BUD-01 retrieval URL for a blob on a server we configured: `${server}/${sha256}${ext}`. */
export function blobUrl(server: string, sha256: string, mime: string): string {
  return `${stripSlash(server)}/${sha256}${EXT_FOR_MIME[mime] ?? ''}`;
}

/** SHA-256 of a file's bytes (the uploaded variant, not the original the user supplied). */
export async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
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
  // Hash the bytes that are actually sent: the re-encoded or remuxed variant, not the original
  // file. MediaRef.sha256 is the original's hash, so it never matches what the server stores.
  const uploadedSha = createHash('sha256').update(bytes).digest('hex');
  const name = basename(media.path);
  const primary = stripSlash(opts.primary);
  const auth = buildBlossomAuth(sk, 'upload', { sha256: uploadedSha, content: `Upload ${name}` });

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
  // The server must positively confirm the hash of the bytes we sent. Nothing else in the reply
  // is used: not its URL, which would otherwise go verbatim into a note signed with the user's key.
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    typeof descriptor.sha256 !== 'string' ||
    descriptor.sha256.toLowerCase() !== uploadedSha
  ) {
    throw new PosterError(
      'UPSTREAM_ERROR',
      `Blossom (${primary}) did not confirm the hash of the uploaded blob`,
      { retryable: false },
    );
  }

  const primaryUrl = blobUrl(primary, uploadedSha, media.mime);
  const urls = [primaryUrl];
  for (const mirror of opts.mirrors) {
    const m = stripSlash(mirror);
    if (m === primary) continue;
    try {
      const mirrorAuth = buildBlossomAuth(sk, 'upload', {
        sha256: uploadedSha,
        content: `Mirror ${name}`,
      });
      const mr = await fetchWithTimeout(`${m}/mirror`, {
        method: 'PUT',
        headers: { Authorization: `Nostr ${mirrorAuth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: primaryUrl }),
        timeoutMs: 60_000,
        signal: opts.signal,
      });
      if (mr.ok) {
        await safeText(mr);
        urls.push(blobUrl(m, uploadedSha, media.mime));
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
  return { urls, sha256: uploadedSha, descriptor };
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
