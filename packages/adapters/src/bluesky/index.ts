/**
 * Bluesky adapter (AT Protocol) via the official `@atproto/api` SDK.
 *
 * - Auth: handle + app password (never the main password). The session (access/refresh JWT) is
 *   stored encrypted and resumed on every publish; a fresh login happens only when resuming fails,
 *   keeping us far below the 30-logins-per-5-minutes limit.
 * - Text goes through `RichText.detectFacets()` so links and @mentions are clickable.
 * - Images: `com.atproto.repo.uploadBlob` → `app.bsky.embed.images` (max 4, alt text, aspect ratio).
 * - Video: video service flow (service auth for `did:web:video.bsky.app`, `uploadVideo`, poll
 *   `getJobStatus` until completed) → `app.bsky.embed.video`. Needs a verified email.
 * - Threads: `reply.root` / `reply.parent` strong refs.
 *
 * References: https://docs.bsky.app/docs/advanced-guides/posts,
 * https://docs.bsky.app/docs/tutorials/video, https://docs.bsky.app/docs/advanced-guides/rate-limits
 */
import { readFile } from 'node:fs/promises';
import {
  AtpAgent,
  RichText,
  XRPCError,
  type AppBskyFeedPost,
  type AtpSessionData,
  type BlobRef,
} from '@atproto/api';
import {
  DEFAULT_LIMITS,
  PartialPublishError,
  PosterError,
  validateAgainstLimits,
  type AccountState,
  type AccountStatus,
  type AdapterContext,
  type Issue,
  type Logger,
  type MediaRef,
  type NetworkAdapter,
  type PublishCtx,
  type PublishResult,
  type RenderedPart,
  type RenderedPost,
  type SelfTestResult,
} from '@poster/core';
import { fetchWithTimeout, readJson, safeText, sleep } from '../http.js';

const NETWORK = 'bluesky' as const;
export const BSKY_SERVICE = 'https://bsky.social';
/** Video service (did:web:video.bsky.app). The service-auth `aud` is the user's own PDS DID. */
const VIDEO_SERVICE_URL = 'https://video.bsky.app';
const VIDEO_POLL_INTERVAL_MS = 3_000;
const VIDEO_POLL_MAX_MS = 10 * 60_000;

export interface BlueskySecrets {
  identifier: string;
  appPassword: string;
  session?: AtpSessionData;
}

export interface BlueskyMeta {
  did: string;
  handle: string;
  emailConfirmed: boolean | null;
  pdsUrl: string | null;
}

/** Map SDK / XRPC errors to stable PosterError codes. */
export function mapBlueskyError(err: unknown, context: string): PosterError {
  if (PosterError.is(err)) return err as PosterError;
  if (
    err instanceof XRPCError ||
    (typeof err === 'object' && err !== null && 'status' in err && 'error' in err)
  ) {
    const e = err as { status: number; error?: string; message?: string };
    const name = e.error ?? '';
    const msg = `${context}: Bluesky responded ${e.status}${name ? ` ${name}` : ''}${e.message ? ` – ${e.message}` : ''}`;
    if (e.status === 429 || name === 'RateLimitExceeded')
      return new PosterError('RATE_LIMITED', msg, { cause: err });
    if (
      e.status === 401 ||
      name === 'AuthenticationRequired' ||
      name === 'ExpiredToken' ||
      name === 'InvalidToken' ||
      name === 'AuthMissing'
    ) {
      return new PosterError('AUTH_REQUIRED', msg, { cause: err });
    }
    if (e.status >= 500 || e.status === 1)
      return new PosterError('UPSTREAM_ERROR', msg, { retryable: true, cause: err });
    if (e.status === 413 || name === 'BlobTooLarge')
      return new PosterError('MEDIA_TOO_LARGE', msg, { retryable: false, cause: err });
    return new PosterError('UPSTREAM_ERROR', msg, { retryable: false, cause: err });
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return new PosterError('NETWORK_ERROR', `${context}: ${err.message}`, { cause: err });
  }
  return new PosterError(
    'UPSTREAM_ERROR',
    `${context}: ${err instanceof Error ? err.message : String(err)}`,
    { retryable: false, cause: err },
  );
}

function isAuthError(err: unknown): boolean {
  return mapBlueskyError(err, '').code === 'AUTH_REQUIRED';
}

/** Create an agent and get an authenticated session, re-logging in only when resume fails. */
export async function openAgent(
  secrets: BlueskySecrets,
  logger: Logger,
  persist?: (session: AtpSessionData) => Promise<void>,
  service: string = BSKY_SERVICE,
): Promise<AtpAgent> {
  const agent = new AtpAgent({ service });
  if (secrets.session) {
    try {
      await agent.resumeSession(secrets.session);
      if (agent.session && persist && agent.session.accessJwt !== secrets.session.accessJwt) {
        await persist(agent.session);
      }
      return agent;
    } catch (err) {
      if (!isAuthError(err) && !(err instanceof XRPCError && err.status === 400)) {
        throw mapBlueskyError(err, 'Resuming Bluesky session');
      }
      logger.info('Stored Bluesky session is no longer valid; logging in with the app password');
    }
  }
  try {
    await agent.login({ identifier: secrets.identifier, password: secrets.appPassword });
  } catch (err) {
    const mapped = mapBlueskyError(err, 'Bluesky login');
    // A rejected app password is an auth problem the user must fix, not a transient one.
    if (mapped.code === 'UPSTREAM_ERROR' && (err as { status?: number }).status === 400) {
      throw new PosterError('AUTH_REQUIRED', mapped.message, { cause: err });
    }
    throw mapped;
  }
  if (agent.session && persist) await persist(agent.session);
  return agent;
}

function secretsFrom(account: AccountState | null): BlueskySecrets {
  const s = account?.secrets as Partial<BlueskySecrets> | null | undefined;
  if (!account || !s?.identifier || !s.appPassword) {
    throw new PosterError(
      'AUTH_REQUIRED',
      'Bluesky is not connected. Add your handle and an app password in the UI.',
    );
  }
  return { identifier: s.identifier, appPassword: s.appPassword, session: s.session };
}

export function postUrl(handleOrDid: string, uri: string): string {
  const rkey = uri.split('/').pop() ?? '';
  return `https://bsky.app/profile/${handleOrDid}/post/${rkey}`;
}

async function uploadImages(
  agent: AtpAgent,
  images: MediaRef[],
): Promise<AppBskyFeedPost.Record['embed']> {
  const uploaded: {
    alt: string;
    image: BlobRef;
    aspectRatio?: { width: number; height: number };
  }[] = [];
  for (const img of images) {
    const bytes = await readFile(img.path);
    const res = await agent.uploadBlob(new Uint8Array(bytes), { encoding: img.mime });
    uploaded.push({
      alt: img.altText ?? '',
      image: res.data.blob,
      ...(img.width && img.height ? { aspectRatio: { width: img.width, height: img.height } } : {}),
    });
  }
  return { $type: 'app.bsky.embed.images', images: uploaded };
}

/**
 * Video upload per https://docs.bsky.app/docs/tutorials/video:
 * 1. service auth token for the video service (lxm com.atproto.repo.uploadBlob, aud = user's PDS DID)
 * 2. POST /xrpc/app.bsky.video.uploadVideo?did=…&name=… with the bytes
 * 3. poll app.bsky.video.getJobStatus until JOB_STATE_COMPLETED → blob ref
 */
async function uploadVideo(
  agent: AtpAgent,
  video: MediaRef,
  ctx: PublishCtx,
): Promise<AppBskyFeedPost.Record['embed']> {
  const did = agent.assertDid;
  const pdsUrl = agent.pdsUrl ?? agent.serviceUrl;
  const pdsHost = pdsUrl.hostname;
  const serviceAuth = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${pdsHost}`,
    lxm: 'com.atproto.repo.uploadBlob',
    exp: Math.floor(Date.now() / 1000) + 30 * 60,
  });
  const token = serviceAuth.data.token;
  const bytes = await readFile(video.path);
  const name = `${video.sha256.slice(0, 16)}.mp4`;
  const uploadUrl = `${VIDEO_SERVICE_URL}/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(did)}&name=${encodeURIComponent(name)}`;
  const res = await fetchWithTimeout(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
    timeoutMs: 5 * 60_000,
    signal: ctx.signal,
  });
  // 409 = already processed (same bytes uploaded before); its body still carries a jobStatus.
  if (!res.ok && res.status !== 409) {
    const text = await safeText(res);
    throw mapBlueskyError(
      { status: res.status, error: 'VideoUpload', message: text.slice(0, 300) },
      'Bluesky video upload',
    );
  }
  let job = (
    await readJson<{
      jobStatus?: { jobId: string; state: string; blob?: BlobRef; error?: string };
    }>(res, 'Bluesky video service')
  )?.jobStatus;
  if (!job?.jobId)
    throw new PosterError('UPSTREAM_ERROR', 'Bluesky video service returned no job id', {
      retryable: true,
    });

  const videoAgent = new AtpAgent({ service: VIDEO_SERVICE_URL });
  const started = Date.now();
  while (job.state !== 'JOB_STATE_COMPLETED') {
    if (job.state === 'JOB_STATE_FAILED') {
      throw new PosterError(
        'UPSTREAM_ERROR',
        `Bluesky video processing failed: ${job.error ?? 'unknown error'}`,
        { retryable: false },
      );
    }
    if (Date.now() - started > VIDEO_POLL_MAX_MS) {
      throw new PosterError('UPSTREAM_ERROR', 'Bluesky video processing did not finish in time', {
        retryable: true,
      });
    }
    await sleep(VIDEO_POLL_INTERVAL_MS, ctx.signal);
    const status = await videoAgent.app.bsky.video.getJobStatus({ jobId: job.jobId });
    job = status.data.jobStatus;
  }
  if (!job.blob)
    throw new PosterError('UPSTREAM_ERROR', 'Bluesky video job completed without a blob', {
      retryable: false,
    });
  return {
    $type: 'app.bsky.embed.video',
    video: job.blob,
    ...(video.altText ? { alt: video.altText } : {}),
    ...(video.width && video.height
      ? { aspectRatio: { width: video.width, height: video.height } }
      : {}),
  };
}

async function buildEmbed(
  agent: AtpAgent,
  part: RenderedPart,
  ctx: PublishCtx,
): Promise<AppBskyFeedPost.Record['embed'] | undefined> {
  const images = part.media.filter((m) => m.kind === 'image');
  const videos = part.media.filter((m) => m.kind === 'video');
  if (videos.length > 0) return uploadVideo(agent, videos[0] as MediaRef, ctx);
  if (images.length > 0) return uploadImages(agent, images.slice(0, 4));
  return undefined;
}

export function createBlueskyAdapter(): NetworkAdapter {
  const adapter: NetworkAdapter = {
    id: NETWORK,
    capabilities: DEFAULT_LIMITS.bluesky,

    connect: {
      kind: 'credentials',
      fields: [
        { name: 'identifier', label: 'Handle', secret: false, placeholder: 'you.bsky.social' },
        {
          name: 'appPassword',
          label: 'App password',
          secret: true,
          placeholder: 'xxxx-xxxx-xxxx-xxxx',
        },
      ],
      async connect(input, ctx) {
        const identifier = (input.identifier ?? '').trim().replace(/^@/, '');
        const appPassword = (input.appPassword ?? '').trim();
        if (!identifier || !appPassword)
          throw new PosterError('VALIDATION', 'Handle and app password are required.');
        if (!/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(appPassword)) {
          ctx.logger.warn(
            'Bluesky password does not look like an app password (xxxx-xxxx-xxxx-xxxx)',
          );
        }
        const agent = await openAgent({ identifier, appPassword }, ctx.logger);
        const session = agent.session;
        if (!session)
          throw new PosterError('AUTH_REQUIRED', 'Bluesky login did not return a session.');
        const emailConfirmed = session.emailConfirmed ?? null;
        const warnings: string[] = [];
        if (emailConfirmed === false)
          warnings.push(
            'Your Bluesky email is not verified; video uploads will be rejected until it is.',
          );
        return {
          handle: session.handle,
          secrets: { identifier, appPassword, session } satisfies BlueskySecrets,
          meta: {
            did: session.did,
            handle: session.handle,
            emailConfirmed,
            pdsUrl: agent.pdsUrl?.toString() ?? null,
          } satisfies BlueskyMeta,
          warnings,
        };
      },
    },

    validate(post: RenderedPost, account: AccountState | null, ctx: AdapterContext): Issue[] {
      const issues = validateAgainstLimits(post, ctx.limits);
      const meta = (account?.meta ?? {}) as Partial<BlueskyMeta>;
      const hasVideo = post.parts.some((p) => p.media.some((m) => m.kind === 'video'));
      if (hasVideo && meta.emailConfirmed === false) {
        issues.push({
          level: 'error',
          code: 'EMAIL_UNVERIFIED',
          network: NETWORK,
          message:
            'Bluesky requires a verified email before video can be uploaded. Verify it in the Bluesky app and reconnect.',
        });
      }
      return issues;
    },

    async connectionStatus(
      account: AccountState | null,
      ctx: AdapterContext,
    ): Promise<AccountStatus> {
      const s = account?.secrets as Partial<BlueskySecrets> | null | undefined;
      const connected =
        !!account && account.status !== 'disconnected' && !!s?.identifier && !!s?.appPassword;
      const meta = (account?.meta ?? {}) as Partial<BlueskyMeta>;
      const warnings: string[] = [];
      if (connected && meta.emailConfirmed === false)
        warnings.push('Email not verified: video uploads will fail.');
      return {
        network: NETWORK,
        connected,
        status: connected
          ? account?.status === 'needs_auth'
            ? 'needs_auth'
            : 'connected'
          : (account?.status ?? 'disconnected'),
        handle: account?.handle ?? meta.handle ?? null,
        limits: ctx.limits,
        warnings,
        expiresAt: null,
        details: {
          did: meta.did ?? null,
          handle: meta.handle ?? null,
          emailConfirmed: meta.emailConfirmed ?? null,
          pds: meta.pdsUrl ?? BSKY_SERVICE,
        },
      };
    },

    async publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult> {
      const secrets = secretsFrom(ctx.account);
      const agent = await openAgent(secrets, ctx.logger, async (session) => {
        await ctx.updateAccount({
          secrets: { ...secrets, session },
          meta: {
            ...ctx.account.meta,
            did: session.did,
            handle: session.handle,
            emailConfirmed: session.emailConfirmed ?? null,
          },
          handle: session.handle,
        });
      });
      const handle = agent.session?.handle ?? ctx.account.handle ?? agent.assertDid;

      const published: string[] = [...(post.publishedRemoteIds ?? [])];
      // Strong refs for threading; for resumed threads we must re-fetch cids of the existing parts.
      let root: { uri: string; cid: string } | undefined;
      let parent: { uri: string; cid: string } | undefined;
      if (published.length > 0) {
        try {
          const res = await agent.app.bsky.feed.getPosts({
            uris: [published[0] as string, published[published.length - 1] as string],
          });
          const byUri = new Map(res.data.posts.map((p) => [p.uri, p.cid]));
          const rootCid = byUri.get(published[0] as string);
          const parentCid = byUri.get(published[published.length - 1] as string);
          if (rootCid && parentCid) {
            root = { uri: published[0] as string, cid: rootCid };
            parent = { uri: published[published.length - 1] as string, cid: parentCid };
          }
        } catch (err) {
          throw mapBlueskyError(err, 'Loading earlier thread parts');
        }
      }

      for (let idx = published.length; idx < post.parts.length; idx++) {
        const part = post.parts[idx] as RenderedPart;
        try {
          const rt = new RichText({ text: part.text });
          await rt.detectFacets(agent);
          const embed = await buildEmbed(agent, part, ctx);
          const record: Partial<AppBskyFeedPost.Record> &
            Omit<AppBskyFeedPost.Record, 'createdAt'> = {
            $type: 'app.bsky.feed.post',
            text: rt.text,
            ...(rt.facets && rt.facets.length ? { facets: rt.facets } : {}),
            ...(embed ? { embed } : {}),
            ...(root && parent ? { reply: { root, parent } } : {}),
          };
          ctx.logger.info({ part: idx + 1, of: post.parts.length }, 'Publishing Bluesky post');
          const res = await agent.post(record);
          published.push(res.uri);
          const ref = { uri: res.uri, cid: res.cid };
          root ??= ref;
          parent = ref;
        } catch (err) {
          const mapped = mapBlueskyError(err, `Bluesky part ${idx + 1}`);
          if (published.length > (post.publishedRemoteIds?.length ?? 0) || idx > 0) {
            throw new PartialPublishError(published, idx, mapped);
          }
          throw mapped;
        }
      }

      const first = published[0];
      return { url: first ? postUrl(handle, first) : undefined, remoteIds: published };
    },

    async selfTest(account: AccountState, ctx: AdapterContext): Promise<SelfTestResult> {
      try {
        const secrets = secretsFrom(account);
        const agent = await openAgent(secrets, ctx.logger);
        const res = await agent.com.atproto.server.getSession();
        return {
          ok: true,
          message: `Session valid for @${res.data.handle}${res.data.emailConfirmed === false ? ' (email not verified)' : ''}`,
          details: {
            did: res.data.did,
            handle: res.data.handle,
            emailConfirmed: res.data.emailConfirmed ?? null,
          },
        };
      } catch (err) {
        const mapped = mapBlueskyError(err, 'Bluesky self-test');
        return { ok: false, message: mapped.message, details: { code: mapped.code } };
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
