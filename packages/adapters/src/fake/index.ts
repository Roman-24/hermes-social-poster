import {
  DEFAULT_LIMITS,
  PosterError,
  validateAgainstLimits,
  type AccountState,
  type AccountStatus,
  type AdapterContext,
  type Issue,
  type Network,
  type NetworkAdapter,
  type PublishCtx,
  type PublishResult,
  type RenderedPost,
} from '@poster/core';

export interface FakeAdapterOptions {
  /** Simulate a failure on publish: a PosterError code, or 'throw' for a plain Error. */
  failWith?: string | null;
  /** Fail only the first N attempts (then succeed). */
  failTimes?: number;
  /** Fail at a given thread part (0-based) with a PartialPublishError-like outcome. */
  failAtPart?: number;
  delayMs?: number;
  connected?: boolean;
  handle?: string;
}

/**
 * In-memory adapter for tests, e2e runs and Milestone 1 development. Publishes to nowhere and
 * returns deterministic URLs. Enable with POSTER_FAKE_ADAPTERS=1 (all networks) in the server.
 */
export function createFakeAdapter(
  id: Network,
  opts: FakeAdapterOptions = {},
): NetworkAdapter & {
  published: { post: RenderedPost; attemptKey: string }[];
  options: FakeAdapterOptions;
} {
  const published: { post: RenderedPost; attemptKey: string }[] = [];
  let failures = 0;
  const options: FakeAdapterOptions = { connected: true, handle: `fake_${id}`, ...opts };

  return {
    id,
    capabilities: DEFAULT_LIMITS[id],
    published,
    options,
    connect: {
      kind: 'credentials',
      fields: [{ name: 'handle', label: 'Handle', secret: false }],
      async connect(input) {
        return {
          handle: input.handle ?? `fake_${id}`,
          secrets: { token: 'fake' },
          meta: { fake: true },
        };
      },
    },
    validate(post: RenderedPost, _account: AccountState | null, ctx: AdapterContext): Issue[] {
      return validateAgainstLimits(post, ctx.limits);
    },
    async connectionStatus(
      account: AccountState | null,
      ctx: AdapterContext,
    ): Promise<AccountStatus> {
      const connected = !!account?.secrets && options.connected !== false;
      return {
        network: id,
        connected,
        status: connected ? 'connected' : account ? account.status : 'disconnected',
        handle: account?.handle ?? null,
        limits: ctx.limits,
        warnings: [],
        expiresAt: null,
        details: { fake: true },
      };
    },
    async publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult> {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (ctx.signal?.aborted) throw new PosterError('INTERNAL', 'aborted');
      if (options.failWith && (options.failTimes === undefined || failures < options.failTimes)) {
        failures++;
        if (options.failWith === 'throw') throw new Error('fake adapter exploded');
        throw new PosterError(options.failWith as never, `fake failure ${options.failWith}`);
      }
      if (options.failAtPart !== undefined && post.parts.length > options.failAtPart) {
        const { PartialPublishError } = await import('@poster/core');
        const ok = post.parts
          .slice(0, options.failAtPart)
          .map((_, i) => `fake-${post.targetId}-${i}`);
        throw new PartialPublishError(
          ok,
          options.failAtPart,
          new PosterError('UPSTREAM_ERROR', 'fake part failure'),
        );
      }
      published.push({ post, attemptKey: ctx.attemptKey });
      const remoteIds = post.parts.map((_, i) => `fake-${post.targetId}-${i}`);
      return { url: `https://fake.${id}.example/${post.targetId}`, remoteIds };
    },
    async selfTest() {
      return { ok: true, message: 'fake adapter OK' };
    },
    async testPost(_account, ctx) {
      return {
        url: `https://fake.${id}.example/test-${ctx.attemptKey}`,
        remoteIds: [`test-${ctx.attemptKey}`],
      };
    },
  };
}
