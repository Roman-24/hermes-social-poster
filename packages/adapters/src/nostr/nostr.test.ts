import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import {
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  PartialPublishError,
  type AccountState,
  type PublishCtx,
  type RenderedPost,
  type Settings,
} from '@poster/core';
import {
  buildNoteTemplate,
  bytesToHex,
  createNostrAdapter,
  imetaTag,
  parseSecretKey,
} from './index.js';
import { PosterError } from '@poster/core';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

/** Minimal relay: records EVENTs and answers OK (true/false). Resolves once listening. */
async function startRelay(accept: boolean) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const events: Event[] = [];
  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.toString()) as unknown[];
      } catch {
        return;
      }
      if (msg[0] === 'EVENT') {
        const ev = msg[1] as Event;
        events.push(ev);
        socket.send(
          JSON.stringify(['OK', ev.id, accept, accept ? '' : 'blocked: test relay refuses']),
        );
      } else if (msg[0] === 'REQ') {
        socket.send(JSON.stringify(['EOSE', msg[1]]));
      }
    });
  });
  return {
    wss,
    events,
    url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const account: AccountState = {
  network: 'nostr',
  status: 'connected',
  handle: nip19.npubEncode(pubkey),
  secrets: { sk: bytesToHex(sk) },
  meta: { npub: nip19.npubEncode(pubkey), pubkey },
  browserProfileDir: null,
  proxy: null,
};

function ctx(relays: string[], minRelays = 2, overrides: Partial<PublishCtx> = {}): PublishCtx {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    nostr: { ...DEFAULT_SETTINGS.nostr, relays, minRelays },
  };
  return {
    logger,
    settings,
    limits: DEFAULT_LIMITS.nostr,
    dataDir: '/tmp',
    debugDir: '/tmp',
    attemptKey: 'a1',
    account,
    updateAccount: async () => {},
    cacheMediaUrls: async () => {},
    ...overrides,
  };
}

function post(parts: string[]): RenderedPost {
  return {
    postId: 'p',
    targetId: 't',
    network: 'nostr',
    parts: parts.map((text) => ({ text, media: [] })),
    scheduledAtUtc: Date.now(),
    thread: parts.length > 1,
  };
}

type Relay = Awaited<ReturnType<typeof startRelay>>;

describe('Nostr adapter', () => {
  let good1: Relay;
  let good2: Relay;
  let bad: Relay;
  beforeAll(async () => {
    [good1, good2, bad] = await Promise.all([
      startRelay(true),
      startRelay(true),
      startRelay(false),
    ]);
  });
  afterAll(async () => {
    await Promise.all([good1.close(), good2.close(), bad.close()]);
  });

  const adapter = createNostrAdapter();

  it('parses nsec and hex keys', () => {
    const nsec = nip19.nsecEncode(sk);
    expect(bytesToHex(parseSecretKey(nsec))).toBe(bytesToHex(sk));
    expect(bytesToHex(parseSecretKey(bytesToHex(sk).toUpperCase()))).toBe(bytesToHex(sk));
    expect(() => parseSecretKey('npub1garbage')).toThrow();
  });

  it('connect derives npub from the key and never echoes the nsec', async () => {
    if (adapter.connect.kind !== 'credentials') throw new Error('expected credentials');
    const res = await adapter.connect.connect({ nsec: nip19.nsecEncode(sk) }, ctx([]));
    expect(res.handle).toBe(nip19.npubEncode(pubkey));
    expect(res.meta.pubkey).toBe(pubkey);
    expect(res.secrets).toEqual({ sk: bytesToHex(sk) });
  });

  it('validate reports NO_RELAYS and the public-media warning', () => {
    const p = post(['hi']);
    (p.parts[0] as { media: unknown[] }).media = [
      { id: 'm', kind: 'image', path: '/x', mime: 'image/png', bytes: 1, sha256: 'a' },
    ];
    const issues = adapter.validate(p, account, ctx([]));
    expect(issues.some((i) => i.code === 'NO_RELAYS' && i.level === 'error')).toBe(true);
    expect(issues.some((i) => i.code === 'NOSTR_MEDIA_PUBLIC' && i.level === 'warning')).toBe(true);
    expect(
      adapter.validate(post(['hi']), account, ctx(['wss://r'])).some((i) => i.code === 'NO_RELAYS'),
    ).toBe(false);
  });

  it('publishes a thread with NIP-10 tags once minRelays answer OK', async () => {
    const relays = [good1.url(), good2.url(), bad.url()];
    const result = await adapter.publish(post(['first', 'second', 'third']), ctx(relays, 2));
    expect(result.remoteIds).toHaveLength(3);
    expect(result.relaysOk).toBe(2);
    expect(result.relaysTotal).toBe(3);
    expect(result.url).toMatch(/^https:\/\/njump\.me\/nevent1/);

    const events = good1.events;
    expect(events).toHaveLength(3);
    for (const ev of events) expect(verifyEvent(ev)).toBe(true);
    const [root, second, third] = events as [Event, Event, Event];
    expect(root.tags.filter((t) => t[0] === 'e')).toHaveLength(0);
    expect(second.tags).toContainEqual(['e', root.id, relays[0], 'root']);
    expect(second.tags).toContainEqual(['e', root.id, relays[0], 'reply']);
    expect(second.tags).toContainEqual(['p', pubkey]);
    expect(third.tags).toContainEqual(['e', root.id, relays[0], 'root']);
    expect(third.tags).toContainEqual(['e', second.id, relays[0], 'reply']);
    expect(third.content).toBe('third');
  });

  it('fails with retryable UPSTREAM_ERROR when fewer than minRelays accept', async () => {
    const err = await adapter
      .publish(post(['solo']), ctx([good1.url(), bad.url()], 2))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });

  it('throws PartialPublishError when a later part fails, and resumes from publishedRemoteIds', async () => {
    const flaky = await startRelay(true);
    const relays = [good1.url(), flaky.url()];
    // Make the second relay refuse the 2nd event only.
    let n = 0;
    flaky.wss.removeAllListeners('connection');
    flaky.wss.on('connection', (socket: WebSocket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as unknown[];
        if (msg[0] === 'EVENT') {
          n++;
          const ev = msg[1] as Event;
          socket.send(JSON.stringify(['OK', ev.id, n !== 2, '']));
        }
      });
    });
    const before = good1.events.length;
    const err = await adapter.publish(post(['a', 'b']), ctx(relays, 2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialPublishError);
    const partial = err as PartialPublishError;
    expect(partial.publishedRemoteIds).toHaveLength(1);
    expect(partial.failedPartIndex).toBe(1);

    // Resume: only part "b" is published, as a reply to the existing root.
    const resumed = await adapter.publish(
      { ...post(['a', 'b']), publishedRemoteIds: partial.publishedRemoteIds },
      ctx([good1.url(), good2.url()], 2),
    );
    expect(resumed.remoteIds).toHaveLength(2);
    expect(resumed.remoteIds[0]).toBe(partial.publishedRemoteIds[0]);
    const newEvents = good1.events.slice(before);
    expect(newEvents.map((e) => e.content)).toEqual(['a', 'b', 'b']);
    const last = newEvents[newEvents.length - 1] as Event;
    expect(last.tags).toContainEqual(['e', partial.publishedRemoteIds[0], good1.url(), 'root']);
    await flaky.close();
  });

  it('builds imeta tags and appends media URLs to the content', () => {
    const media = {
      id: 'm',
      kind: 'image' as const,
      path: '/x',
      mime: 'image/png',
      bytes: 42,
      sha256: 'ab',
      width: 100,
      height: 50,
      altText: 'alt text',
    };
    expect(imetaTag(media, 'https://b/x.png')).toEqual([
      'imeta',
      'url https://b/x.png',
      'm image/png',
      'x ab',
      'size 42',
      'dim 100x50',
      'alt alt text',
    ]);
    const t = buildNoteTemplate(
      { text: 'hello', mediaUrls: [{ media, url: 'https://b/x.png' }] },
      null,
      1,
    );
    expect(t.content).toBe('hello\n\nhttps://b/x.png');
    expect(t.tags[0]?.[0]).toBe('imeta');
  });

  it('connectionStatus reflects key presence and relay configuration', async () => {
    const s = await adapter.connectionStatus(account, ctx([good1.url()], 2));
    expect(s.connected).toBe(true);
    expect(s.handle).toBe(nip19.npubEncode(pubkey));
    expect(s.warnings.join(' ')).toMatch(/Only 1 relay/);
    const none = await adapter.connectionStatus(null, ctx([]));
    expect(none.connected).toBe(false);
    expect(none.status).toBe('disconnected');
  });

  it('selfTest counts reachable relays', async () => {
    const res = await adapter.selfTest?.(account, ctx([good1.url(), good2.url()], 2));
    expect(res?.ok).toBe(true);
    expect(res?.message).toMatch(/2\/2 relays reachable/);
  });
});

/** A relay whose answer can change between attempts. */
async function startSwitchRelay(initial: 'ok' | 'refuse' | 'duplicate') {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const events: Event[] = [];
  const state = { mode: initial };
  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as unknown[];
      if (msg[0] === 'EVENT') {
        const ev = msg[1] as Event;
        if (state.mode === 'ok') events.push(ev);
        socket.send(
          JSON.stringify([
            'OK',
            ev.id,
            state.mode === 'ok',
            state.mode === 'refuse'
              ? 'rate-limited: slow down'
              : state.mode === 'duplicate'
                ? 'duplicate: have this event'
                : '',
          ]),
        );
      } else if (msg[0] === 'REQ') socket.send(JSON.stringify(['EOSE', msg[1]]));
    });
  });
  return {
    wss,
    events,
    state,
    url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

describe('Nostr retry safety', () => {
  it('re-sends the same signed event after a partial acknowledgement, so no second note appears', async () => {
    const a = await startSwitchRelay('ok');
    const b = await startSwitchRelay('refuse');
    const adapter = createNostrAdapter();
    const scheduledAtUtc = Date.parse('2026-05-01T10:00:00Z');
    const p: RenderedPost = { ...post(['one note']), scheduledAtUtc };
    try {
      // minRelays 2: only relay A answers OK, so the first attempt fails but A already holds the note.
      await expect(adapter.publish(p, ctx([a.url(), b.url()], 2))).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR',
        retryable: true,
      });
      expect(a.events).toHaveLength(1);

      // A later attempt, a different wall-clock second, with relay B now accepting.
      await new Promise((r) => setTimeout(r, 1_100));
      b.state.mode = 'ok';
      a.state.mode = 'duplicate';
      const result = await adapter.publish(p, ctx([a.url(), b.url()], 2));
      expect(result.remoteIds).toHaveLength(1);
      expect(b.events).toHaveLength(1);
      // Same event on both relays: same id, same created_at taken from the scheduled time.
      expect(b.events[0]?.id).toBe(a.events[0]?.id);
      expect(a.events[0]?.created_at).toBe(Math.floor(scheduledAtUtc / 1000));
      expect(verifyEvent(b.events[0] as Event)).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('counts a "duplicate:" answer as an acknowledgement', async () => {
    const a = await startSwitchRelay('duplicate');
    const b = await startSwitchRelay('duplicate');
    try {
      const r = await createNostrAdapter().publish(
        post(['already there']),
        ctx([a.url(), b.url()], 2),
      );
      expect(r.relaysOk).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('gives thread parts distinct, ordered timestamps derived from the schedule', async () => {
    const a = await startSwitchRelay('ok');
    const scheduledAtUtc = Date.parse('2026-05-01T10:00:00Z');
    try {
      await createNostrAdapter().publish(
        { ...post(['first', 'second', 'third']), scheduledAtUtc },
        ctx([a.url()], 1),
      );
      expect(a.events.map((e) => e.created_at)).toEqual(
        [0, 1, 2].map((i) => scheduledAtUtc / 1000 + i),
      );
    } finally {
      await a.close();
    }
  });
});

describe('parseSecretKey errors', () => {
  it('does not echo a mistyped nsec, its checksum or the library error', () => {
    const good = nip19.nsecEncode(sk);
    const typo = `${good.slice(0, -1)}${good.endsWith('q') ? 'p' : 'q'}`;
    let caught: unknown;
    try {
      parseSecretKey(typo);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PosterError);
    const e = caught as PosterError;
    expect(e.code).toBe('VALIDATION');
    expect(e.message).not.toContain(typo.slice(5));
    expect(e.message).not.toContain(good.slice(-6));
    expect(JSON.stringify({ message: e.message, stack: e.stack, cause: e.cause })).not.toContain(
      typo.slice(10, 40),
    );
    expect(e.cause).toBeUndefined();
  });
});
