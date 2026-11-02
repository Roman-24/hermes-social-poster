/**
 * Nostr adapter.
 *
 * - Signs kind 1 notes directly with the user's key (nostr-tools `finalizeEvent`).
 * - Publishes to the fixed relay list from settings; a note counts as published once at least
 *   `settings.nostr.minRelays` relays return OK.
 * - Media goes to Blossom first (see ./blossom.ts); URLs are appended to the content and described
 *   with NIP-92 `imeta` tags.
 * - Threads follow NIP-10: part 2+ carries `e` tags marked `root` / `reply` and a `p` tag.
 *
 * References: NIP-01, NIP-10, NIP-19, NIP-92, Blossom BUD-01/02/04.
 */
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { WebSocket as WsWebSocket } from 'ws';
import {
  DEFAULT_LIMITS,
  PartialPublishError,
  PosterError,
  validateAgainstLimits,
  type AccountState,
  type AccountStatus,
  type AdapterContext,
  type Issue,
  type MediaRef,
  type NetworkAdapter,
  type PublishCtx,
  type PublishResult,
  type RenderedPart,
  type RenderedPost,
  type SelfTestResult,
} from '@poster/core';
import { uploadToBlossom } from './blossom.js';

// nostr-tools needs a WebSocket implementation under Node < 22; newer Node has a global one.
if (typeof WebSocket === 'undefined') {
  useWebSocketImplementation(WsWebSocket);
}

const PUBLISH_MAX_WAIT_MS = 8_000;
const NETWORK = 'nostr' as const;

export interface NostrSecrets {
  /** 32-byte secret key as 64 hex chars. */
  sk: string;
}

export interface NostrMeta {
  npub: string;
  pubkey: string;
}

/** Accept `nsec1…` or 64 hex characters; returns the key bytes. */
export function parseSecretKey(input: string): Uint8Array {
  const s = input.trim();
  if (/^nsec1[02-9ac-hj-np-z]+$/i.test(s)) {
    const decoded = nip19.decode(s.toLowerCase());
    if (decoded.type !== 'nsec') throw new PosterError('VALIDATION', 'Not an nsec key.');
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase());
  throw new PosterError(
    'VALIDATION',
    'Enter your Nostr secret key as nsec1… or 64 hex characters.',
  );
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function skFromAccount(account: AccountState | null): Uint8Array {
  const sk = (account?.secrets as Partial<NostrSecrets> | null | undefined)?.sk;
  if (!account || !sk || !/^[0-9a-f]{64}$/.test(sk)) {
    throw new PosterError('AUTH_REQUIRED', 'Nostr key is not configured. Add your nsec in the UI.');
  }
  return hexToBytes(sk);
}

function relaysFrom(ctx: AdapterContext): string[] {
  return [...new Set(ctx.settings.nostr.relays.map((r) => r.trim()).filter(Boolean))];
}

/** Build NIP-92 imeta tag for one uploaded media item. */
export function imetaTag(media: MediaRef, url: string): string[] {
  const fields = [`url ${url}`, `m ${media.mime}`, `x ${media.sha256}`, `size ${media.bytes}`];
  if (media.width && media.height) fields.push(`dim ${media.width}x${media.height}`);
  if (media.altText) fields.push(`alt ${media.altText}`);
  return ['imeta', ...fields];
}

export interface BuiltNote {
  template: { kind: 1; created_at: number; tags: string[][]; content: string };
}

/**
 * Compose the kind 1 event template for one thread part.
 * `thread` carries the ids of the root and previous events when this is a reply.
 */
export function buildNoteTemplate(
  part: { text: string; mediaUrls: { media: MediaRef; url: string }[] },
  thread: { rootId: string; parentId: string; relayHint: string; pubkey: string } | null,
  createdAt: number = Math.floor(Date.now() / 1000),
): BuiltNote['template'] {
  const tags: string[][] = [];
  if (thread) {
    tags.push(['e', thread.rootId, thread.relayHint, 'root']);
    if (thread.parentId !== thread.rootId)
      tags.push(['e', thread.parentId, thread.relayHint, 'reply']);
    else tags.push(['e', thread.parentId, thread.relayHint, 'reply']);
    tags.push(['p', thread.pubkey]);
  }
  for (const { media, url } of part.mediaUrls) tags.push(imetaTag(media, url));
  const urls = part.mediaUrls.map((m) => m.url);
  const content = urls.length ? `${part.text.trimEnd()}\n\n${urls.join('\n')}` : part.text;
  return { kind: 1, created_at: createdAt, tags, content };
}

/** Publish an already-signed event and count OK acknowledgements. */
export async function publishEvent(
  pool: SimplePool,
  relays: string[],
  event: NostrEvent,
  opts: {
    minRelays: number;
    maxWaitMs?: number;
    signal?: AbortSignal;
    logger: AdapterContext['logger'];
  },
): Promise<{ ok: number; total: number; failures: string[] }> {
  const results = await Promise.allSettled(
    pool.publish(relays, event, {
      maxWait: opts.maxWaitMs ?? PUBLISH_MAX_WAIT_MS,
      abort: opts.signal,
    }),
  );
  const failures: string[] = [];
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++;
    else
      failures.push(
        `${relays[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
  });
  if (failures.length) opts.logger.warn({ failures }, 'Some relays did not accept the note');
  if (ok < opts.minRelays) {
    throw new PosterError(
      'UPSTREAM_ERROR',
      `Only ${ok}/${relays.length} relays accepted the note (need ${opts.minRelays}). ${failures.join('; ')}`,
      {
        retryable: true,
        extra: { relaysOk: ok, relaysTotal: relays.length },
      },
    );
  }
  return { ok, total: relays.length, failures };
}

export function noteUrl(id: string, relays: string[]): string {
  try {
    const hint = relays[0];
    return `https://njump.me/${nip19.neventEncode(hint ? { id, relays: [hint] } : { id })}`;
  } catch {
    return `https://njump.me/${nip19.noteEncode(id)}`;
  }
}

export function createNostrAdapter(): NetworkAdapter {
  const adapter: NetworkAdapter = {
    id: NETWORK,
    capabilities: DEFAULT_LIMITS.nostr,

    connect: {
      kind: 'credentials',
      fields: [
        { name: 'nsec', label: 'Secret key (nsec or hex)', secret: true, placeholder: 'nsec1…' },
      ],
      async connect(input) {
        const sk = parseSecretKey(input.nsec ?? '');
        const pubkey = getPublicKey(sk);
        const npub = nip19.npubEncode(pubkey);
        return {
          handle: npub,
          secrets: { sk: bytesToHex(sk) } satisfies NostrSecrets,
          meta: { npub, pubkey } satisfies NostrMeta,
        };
      },
    },

    validate(post: RenderedPost, _account: AccountState | null, ctx: AdapterContext): Issue[] {
      const issues = validateAgainstLimits(post, ctx.limits);
      if (relaysFrom(ctx).length === 0) {
        issues.push({
          level: 'error',
          code: 'NO_RELAYS',
          network: NETWORK,
          message: 'No Nostr relays configured. Add relays in Settings.',
        });
      }
      if (post.parts.some((p) => p.media.length > 0)) {
        issues.push({
          level: 'warning',
          code: 'NOSTR_MEDIA_PUBLIC',
          network: NETWORK,
          message:
            'Media uploaded to Blossom is public and stays downloadable by anyone with the link, even after the note is deleted.',
        });
      }
      return issues;
    },

    async connectionStatus(
      account: AccountState | null,
      ctx: AdapterContext,
    ): Promise<AccountStatus> {
      const sk = (account?.secrets as Partial<NostrSecrets> | null | undefined)?.sk;
      const connected =
        !!account &&
        account.status !== 'disconnected' &&
        typeof sk === 'string' &&
        /^[0-9a-f]{64}$/.test(sk);
      const relays = relaysFrom(ctx);
      const warnings: string[] = [];
      if (connected && relays.length === 0)
        warnings.push('No relays configured; notes cannot be published.');
      if (connected && relays.length < ctx.settings.nostr.minRelays) {
        warnings.push(
          `Only ${relays.length} relay(s) configured but ${ctx.settings.nostr.minRelays} OK responses are required.`,
        );
      }
      const meta = (account?.meta ?? {}) as Partial<NostrMeta>;
      return {
        network: NETWORK,
        connected,
        status: connected ? 'connected' : (account?.status ?? 'disconnected'),
        handle: account?.handle ?? meta.npub ?? null,
        limits: ctx.limits,
        warnings,
        expiresAt: null,
        details: {
          npub: meta.npub ?? null,
          relays: relays.length,
          blossom: ctx.settings.blossom.primary,
          mirrors: ctx.settings.blossom.mirrors.length,
        },
      };
    },

    async publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult> {
      const sk = skFromAccount(ctx.account);
      const pubkey = getPublicKey(sk);
      const relays = relaysFrom(ctx);
      if (relays.length === 0)
        throw new PosterError('VALIDATION', 'No Nostr relays configured.', { retryable: false });
      const relayHint = relays[0] ?? '';
      const pool = new SimplePool();
      const published: string[] = [...(post.publishedRemoteIds ?? [])];
      let relaysOk = 0;

      try {
        for (let idx = published.length; idx < post.parts.length; idx++) {
          const part = post.parts[idx] as RenderedPart;
          try {
            const mediaUrls = await uploadPartMedia(part, sk, ctx);
            const rootId = published[0];
            const parentId = published[published.length - 1];
            const template = buildNoteTemplate(
              { text: part.text, mediaUrls },
              rootId && parentId ? { rootId, parentId, relayHint, pubkey } : null,
            );
            const event = finalizeEvent(template, sk);
            ctx.logger.info(
              { part: idx + 1, of: post.parts.length, id: event.id },
              'Publishing Nostr note',
            );
            const r = await publishEvent(pool, relays, event, {
              minRelays: ctx.settings.nostr.minRelays,
              signal: ctx.signal,
              logger: ctx.logger,
            });
            relaysOk = r.ok;
            published.push(event.id);
          } catch (err) {
            if (published.length > (post.publishedRemoteIds?.length ?? 0) || idx > 0) {
              throw new PartialPublishError(published, idx, err);
            }
            throw err;
          }
        }
      } finally {
        try {
          pool.close(relays);
        } catch {
          /* ignore */
        }
      }

      const first = published[0];
      return {
        url: first ? noteUrl(first, relays) : undefined,
        remoteIds: published,
        relaysOk,
        relaysTotal: relays.length,
      };
    },

    async selfTest(account: AccountState, ctx: AdapterContext): Promise<SelfTestResult> {
      const sk = skFromAccount(account);
      const pubkey = getPublicKey(sk);
      const relays = relaysFrom(ctx);
      if (relays.length === 0) return { ok: false, message: 'No relays configured.' };
      const pool = new SimplePool();
      try {
        const reachable: string[] = [];
        const unreachable: string[] = [];
        await Promise.all(
          relays.map(async (r) => {
            try {
              await pool.ensureRelay(r, { connectionTimeout: 5_000 });
              reachable.push(r);
            } catch {
              unreachable.push(r);
            }
          }),
        );
        let profile: NostrEvent | null = null;
        if (reachable.length) {
          profile = await pool
            .get(reachable, { kinds: [0], authors: [pubkey] }, { maxWait: 5_000 })
            .catch(() => null);
        }
        const ok = reachable.length >= ctx.settings.nostr.minRelays;
        return {
          ok,
          message: ok
            ? `${reachable.length}/${relays.length} relays reachable${profile ? ', profile found' : ''}`
            : `Only ${reachable.length}/${relays.length} relays reachable (need ${ctx.settings.nostr.minRelays}).`,
          details: { reachable, unreachable, profileFound: !!profile },
        };
      } finally {
        pool.close(relays);
      }
    },

    async testPost(_account: AccountState, ctx: PublishCtx): Promise<PublishResult> {
      const text = `Social Poster test ${new Date().toISOString()}`;
      return adapter.publish(
        {
          postId: 'test',
          targetId: `test-${ctx.attemptKey}`,
          network: NETWORK,
          parts: [{ text, media: [] }],
          scheduledAtUtc: Date.now(),
          thread: false,
        },
        ctx,
      );
    },
  };
  return adapter;
}

async function uploadPartMedia(
  part: RenderedPart,
  sk: Uint8Array,
  ctx: PublishCtx,
): Promise<{ media: MediaRef; url: string }[]> {
  const out: { media: MediaRef; url: string }[] = [];
  for (const media of part.media) {
    if (media.blossomUrls && media.blossomUrls.length > 0) {
      out.push({ media, url: media.blossomUrls[0] as string });
      continue;
    }
    const result = await uploadToBlossom(media, sk, {
      primary: ctx.settings.blossom.primary,
      mirrors: ctx.settings.blossom.mirrors,
      logger: ctx.logger,
      signal: ctx.signal,
    });
    media.blossomUrls = result.urls;
    await ctx.cacheMediaUrls?.(media.id, result.urls);
    out.push({ media, url: result.urls[0] as string });
  }
  return out;
}
