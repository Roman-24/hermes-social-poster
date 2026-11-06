import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  PartialPublishError,
  type AccountState,
  type PublishCtx,
  type RenderedPost,
} from '@poster/core';

/** A stand-in for rettiwt-api: the tests decide what the timeline holds and what post() returns. */
const rettiwt = vi.hoisted(() => ({
  state: {
    timeline: [] as unknown[],
    posts: [] as (string | undefined)[],
    posted: [] as { text: string; replyTo?: string }[],
  },
}));

vi.mock('rettiwt-api', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  class FakeRettiwt {
    user = {
      timeline: async () => ({ list: rettiwt.state.timeline }),
      details: async () => ({ userName: 'me' }),
    };
    tweet = {
      upload: async () => 'media-1',
      post: async (arg: { text: string; replyTo?: string }) => {
        rettiwt.state.posted.push({ text: arg.text, replyTo: arg.replyTo });
        return rettiwt.state.posts.shift();
      },
    };
  }
  return { ...real, Rettiwt: FakeRettiwt };
});

const { createXAdapter } = await import('./index.js');

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const ME = '42';
const account: AccountState = {
  network: 'x',
  status: 'connected',
  handle: '@me',
  secrets: { apiKey: 'k' },
  meta: { userId: ME, userName: 'me' },
  browserProfileDir: null,
  proxy: null,
};

const ctx = (): PublishCtx => ({
  logger,
  settings: DEFAULT_SETTINGS,
  limits: DEFAULT_LIMITS.x,
  dataDir: '/tmp',
  debugDir: '/tmp',
  attemptKey: 'a1',
  account,
  updateAccount: async () => {},
});

const tweet = (over: Record<string, unknown> = {}) => ({
  id: '100',
  fullText: 'GM',
  createdAt: new Date().toISOString(),
  tweetBy: { id: ME },
  retweetedTweet: undefined,
  url: 'https://x.com/me/status/100',
  ...over,
});

const post = (parts: { text: string; media?: boolean }[]): RenderedPost => ({
  postId: 'p',
  targetId: 't',
  network: 'x',
  parts: parts.map((p) => ({
    text: p.text,
    media: p.media
      ? [
          {
            id: 'm',
            kind: 'image' as const,
            path: '/tmp/x.png',
            mime: 'image/png',
            bytes: 1,
            sha256: 'a',
          },
        ]
      : [],
  })),
  scheduledAtUtc: Date.now(),
  thread: parts.length > 1,
});

const adapter = createXAdapter({} as never);

beforeEach(() => {
  rettiwt.state.timeline = [];
  rettiwt.state.posts = [undefined]; // X "accepted" the request but returned no tweet id
  rettiwt.state.posted = [];
});

describe('X reconciliation after a response without a tweet id', () => {
  const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

  it("does not record an older identical tweet as this attempt's post", async () => {
    rettiwt.state.timeline = [tweet({ id: '222', createdAt: old })];
    await expect(adapter.publish(post([{ text: 'GM' }]), ctx())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
  });

  it('does not accept a tweet that merely starts with the text', async () => {
    rettiwt.state.timeline = [tweet({ id: '444', fullText: 'GM frens, new thread incoming' })];
    await expect(adapter.publish(post([{ text: 'GM' }]), ctx())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
  });

  it('does not match anything for a media-only part, and ignores retweets and other authors', async () => {
    rettiwt.state.timeline = [
      tweet({ id: '333', fullText: 'RT @someone: unrelated', retweetedTweet: { id: '9' } }),
      tweet({ id: '555', fullText: '', tweetBy: { id: '7' } }),
    ];
    await expect(adapter.publish(post([{ text: '', media: true }]), ctx())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
    rettiwt.state.posts = [undefined];
    rettiwt.state.timeline = [
      tweet({ id: '666', fullText: 'GM', retweetedTweet: { id: '9' } }),
      tweet({ id: '777', fullText: 'GM', tweetBy: { id: '7' } }),
    ];
    await expect(adapter.publish(post([{ text: 'GM' }]), ctx())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
  });

  it('still recovers a tweet this attempt really created', async () => {
    rettiwt.state.timeline = [
      tweet({ id: '900', fullText: 'GM', createdAt: new Date().toISOString() }),
    ];
    const r = await adapter.publish(post([{ text: 'GM' }]), ctx());
    expect(r.remoteIds).toEqual(['900']);
  });

  it('never reuses an id already recorded for an earlier part of the same thread', async () => {
    rettiwt.state.posts = ['100', undefined];
    rettiwt.state.timeline = [tweet({ id: '100', fullText: 'same text' })];
    const err = await adapter
      .publish(post([{ text: 'same text' }, { text: 'same text' }]), ctx())
      .catch((e: unknown) => e);
    // Part 1 is out; part 2 stays unresolved rather than being matched to part 1's tweet.
    expect(err).toBeInstanceOf(PartialPublishError);
    expect((err as PartialPublishError).publishedRemoteIds).toEqual(['100']);
    expect(((err as PartialPublishError).cause as { code: string }).code).toBe('UNKNOWN_OUTCOME');
  });
});
