/**
 * LinkedIn adapter: official REST API, OAuth 2.0 (PKCE), personal profile only (`urn:li:person:…`).
 *
 * - Posts: `POST /rest/posts` with the "little" text format; special characters are escaped
 *   (`escapeLinkedInText`) or the post is silently truncated.
 * - Images: `POST /rest/images?action=initializeUpload` → PUT bytes → poll `GET /rest/images/{urn}`.
 * - Video: `POST /rest/videos?action=initializeUpload` → PUT chunks (collect ETags) →
 *   `POST /rest/videos?action=finalizeUpload`. `w_member_social` is write-only, so the processing
 *   status cannot be polled: wait, then create the post and retry with backoff if LinkedIn says
 *   the video is not ready yet.
 * - Tokens last ~60 days; refresh tokens are not granted to every app. We warn 7 days before expiry.
 *
 * References:
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 */
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LIMITS,
  PosterError,
  escapeLinkedInText,
  validateAgainstLimits,
  type AccountState,
  type AccountStatus,
  type AdapterContext,
  type Issue,
  type MediaRef,
  type NetworkAdapter,
  type PublishCtx,
  type PublishResult,
  type RenderedPost,
  type SelfTestResult,
} from '@poster/core';
import { expectOk, fetchWithTimeout, readJson, sleep } from '../http.js';

const NETWORK = 'linkedin' as const;

/** One place for the versioned API header; bump deliberately and re-test. */
export const LINKEDIN_VERSION = '202510';
export const LINKEDIN_API = 'https://api.linkedin.com';
export const LINKEDIN_OAUTH_AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_OAUTH_TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'];

const TOKEN_WARN_MS = 7 * 24 * 3600_000;
const IMAGE_POLL_INTERVAL_MS = 2_000;
const IMAGE_POLL_MAX_MS = 60_000;
/** Time to let LinkedIn process an uploaded video before the first post attempt. */
export const VIDEO_SETTLE_MS = 30_000;
/** Backoff when post creation fails because the video is still processing. */
export const VIDEO_RETRY_BACKOFF_MS = [10_000, 30_000, 60_000, 60_000];

export interface LinkedInAdapterOptions {
  /** Resolve the LinkedIn app client id/secret at call time (stored encrypted in the vault). */
  getClientCredentials(): Promise<{ clientId: string; clientSecret: string } | null>;
  /** Test hook: shorten waits. */
  timing?: { videoSettleMs?: number; videoRetryBackoffMs?: number[]; imagePollIntervalMs?: number };
}

export interface LinkedInSecrets {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshTokenExpiresAt?: number;
}

export interface LinkedInMeta {
  personUrn: string;
  name: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

interface UserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
}

function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
    ...extra,
  };
}

function secretsFrom(account: AccountState | null): LinkedInSecrets {
  const s = account?.secrets as Partial<LinkedInSecrets> | null | undefined;
  if (!account || !s?.accessToken) {
    throw new PosterError('AUTH_REQUIRED', 'LinkedIn is not connected. Connect it in the UI.');
  }
  if (s.expiresAt && s.expiresAt <= Date.now()) {
    throw new PosterError(
      'AUTH_REQUIRED',
      'LinkedIn access token has expired. Reconnect LinkedIn in the UI.',
    );
  }
  return {
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    expiresAt: s.expiresAt ?? 0,
    refreshTokenExpiresAt: s.refreshTokenExpiresAt,
  };
}

function personUrnFrom(account: AccountState): string {
  const urn = (account.meta as Partial<LinkedInMeta>).personUrn;
  if (!urn)
    throw new PosterError('AUTH_REQUIRED', 'LinkedIn account has no person URN; reconnect.');
  return urn;
}

/** Build the LinkedIn post body (exported for tests). */
export function buildPostBody(
  author: string,
  text: string,
  media: { kind: 'image' | 'video'; urn: string; altText?: string }[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    author,
    commentary: escapeLinkedInText(text),
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (media.length === 1) {
    const m = media[0] as { urn: string; altText?: string };
    body.content = { media: { id: m.urn, ...(m.altText ? { altText: m.altText } : {}) } };
  } else if (media.length > 1) {
    body.content = {
      multiImage: {
        images: media.map((m) => ({ id: m.urn, ...(m.altText ? { altText: m.altText } : {}) })),
      },
    };
  }
  return body;
}

async function uploadImage(
  token: string,
  owner: string,
  media: MediaRef,
  ctx: PublishCtx,
  pollInterval: number,
): Promise<string> {
  const init = await fetchWithTimeout(`${LINKEDIN_API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
    signal: ctx.signal,
  });
  await expectOk(init, { service: 'LinkedIn images.initializeUpload' });
  const data = await readJson<{ value: { uploadUrl: string; image: string } }>(init, 'LinkedIn');
  const { uploadUrl, image: urn } = data.value;

  const bytes = await readFile(media.path);
  const put = await fetchWithTimeout(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
    timeoutMs: 120_000,
    signal: ctx.signal,
  });
  await expectOk(put, { service: 'LinkedIn image upload' });

  // Poll until processed (bounded). PROCESSING → AVAILABLE | PROCESSING_FAILED.
  const started = Date.now();
  while (Date.now() - started < IMAGE_POLL_MAX_MS) {
    const res = await fetchWithTimeout(`${LINKEDIN_API}/rest/images/${encodeURIComponent(urn)}`, {
      headers: apiHeaders(token),
      signal: ctx.signal,
    });
    if (res.status === 404) {
      await sleep(pollInterval, ctx.signal);
      continue;
    }
    await expectOk(res, { service: 'LinkedIn images.get' });
    const info = await readJson<{ status?: string }>(res, 'LinkedIn');
    if (info?.status === 'AVAILABLE') return urn;
    if (info?.status === 'PROCESSING_FAILED') {
      throw new PosterError('UPSTREAM_ERROR', `LinkedIn could not process image ${media.id}`, {
        retryable: false,
      });
    }
    await sleep(pollInterval, ctx.signal);
  }
  ctx.logger.warn({ urn }, 'LinkedIn image still processing after the poll window; posting anyway');
  return urn;
}

async function uploadVideo(
  token: string,
  owner: string,
  media: MediaRef,
  ctx: PublishCtx,
): Promise<string> {
  const bytes = await readFile(media.path);
  const init = await fetchWithTimeout(`${LINKEDIN_API}/rest/videos?action=initializeUpload`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({
      initializeUploadRequest: {
        owner,
        fileSizeBytes: bytes.byteLength,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    }),
    signal: ctx.signal,
  });
  await expectOk(init, { service: 'LinkedIn videos.initializeUpload' });
  const data = await readJson<{
    value: {
      video: string;
      uploadToken: string;
      uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[];
    };
  }>(init, 'LinkedIn');
  const { video: urn, uploadToken, uploadInstructions } = data.value;

  const etags: string[] = [];
  for (const part of uploadInstructions) {
    const chunk = bytes.subarray(part.firstByte, part.lastByte + 1);
    const put = await fetchWithTimeout(part.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: chunk,
      timeoutMs: 300_000,
      signal: ctx.signal,
    });
    await expectOk(put, { service: 'LinkedIn video chunk upload' });
    const etag = put.headers.get('etag');
    if (!etag)
      throw new PosterError('UPSTREAM_ERROR', 'LinkedIn video chunk upload returned no ETag', {
        retryable: true,
      });
    etags.push(etag);
  }

  const fin = await fetchWithTimeout(`${LINKEDIN_API}/rest/videos?action=finalizeUpload`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({
      finalizeUploadRequest: { video: urn, uploadToken, uploadedPartIds: etags },
    }),
    signal: ctx.signal,
  });
  await expectOk(fin, { service: 'LinkedIn videos.finalizeUpload' });
  return urn;
}

function looksLikeStillProcessing(err: unknown): boolean {
  if (!PosterError.is(err)) return false;
  const e = err as PosterError;
  const status = e.extra.httpStatus as number | undefined;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 429 &&
    /process|not ready|unavailable|pending|invalid.*media|media.*invalid/i.test(e.message)
  );
}

async function createPost(
  token: string,
  body: Record<string, unknown>,
  ctx: PublishCtx,
): Promise<string> {
  const res = await fetchWithTimeout(`${LINKEDIN_API}/rest/posts`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  await expectOk(res, { service: 'LinkedIn posts.create' });
  const urn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id');
  await res.text().catch(() => '');
  if (!urn)
    throw new PosterError(
      'UNKNOWN_OUTCOME',
      'LinkedIn accepted the post but returned no id header (x-restli-id). Check your feed before retrying.',
      {
        retryable: false,
      },
    );
  return urn;
}

export function linkedInPostUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}`;
}

export function createLinkedInAdapter(opts: LinkedInAdapterOptions): NetworkAdapter {
  const videoSettleMs = opts.timing?.videoSettleMs ?? VIDEO_SETTLE_MS;
  const videoBackoff = opts.timing?.videoRetryBackoffMs ?? VIDEO_RETRY_BACKOFF_MS;
  const imagePollInterval = opts.timing?.imagePollIntervalMs ?? IMAGE_POLL_INTERVAL_MS;

  return {
    id: NETWORK,
    capabilities: DEFAULT_LIMITS.linkedin,

    connect: {
      kind: 'oauth',
      authorizeUrl({ redirectUri, state, codeChallenge, clientId }) {
        const u = new URL(LINKEDIN_OAUTH_AUTHORIZE);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('state', state);
        u.searchParams.set('scope', LINKEDIN_SCOPES.join(' '));
        u.searchParams.set('code_challenge', codeChallenge);
        u.searchParams.set('code_challenge_method', 'S256');
        return u.toString();
      },
      async exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret }, ctx) {
        const form = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        });
        const res = await fetchWithTimeout(LINKEDIN_OAUTH_TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        await expectOk(res, {
          service: 'LinkedIn token exchange',
          authErrorCode: 'UPSTREAM_ERROR',
        });
        const tok = await readJson<TokenResponse>(res, 'LinkedIn');
        if (!tok?.access_token)
          throw new PosterError('UPSTREAM_ERROR', 'LinkedIn token response had no access_token', {
            retryable: false,
          });
        const now = Date.now();
        const expiresAt = now + (tok.expires_in ?? 60 * 24 * 3600) * 1000;
        const refreshTokenExpiresAt = tok.refresh_token_expires_in
          ? now + tok.refresh_token_expires_in * 1000
          : undefined;

        const me = await fetchWithTimeout(`${LINKEDIN_API}/v2/userinfo`, {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        });
        await expectOk(me, { service: 'LinkedIn userinfo' });
        const info = await readJson<UserInfo>(me, 'LinkedIn');
        if (!info?.sub)
          throw new PosterError('UPSTREAM_ERROR', 'LinkedIn userinfo returned no subject', {
            retryable: false,
          });
        const name =
          info.name ??
          [info.given_name, info.family_name].filter(Boolean).join(' ') ??
          'LinkedIn member';
        ctx.logger.info({ expiresAt: new Date(expiresAt).toISOString() }, 'LinkedIn connected');
        const warnings: string[] = [];
        if (!tok.refresh_token)
          warnings.push(
            'LinkedIn did not grant a refresh token; you will need to reconnect when the access token expires (about 60 days).',
          );
        return {
          handle: name,
          secrets: {
            accessToken: tok.access_token,
            ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
            expiresAt,
            ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
          } satisfies LinkedInSecrets,
          meta: {
            personUrn: `urn:li:person:${info.sub}`,
            name,
            expiresAt,
            ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
          } satisfies LinkedInMeta,
          warnings,
        };
      },
    },

    validate(post: RenderedPost, _account: AccountState | null, ctx: AdapterContext): Issue[] {
      const issues = validateAgainstLimits(post, ctx.limits);
      if (post.parts.length > 1 && !issues.some((i) => i.code === 'THREADS_UNSUPPORTED')) {
        issues.push({
          level: 'error',
          code: 'THREADS_UNSUPPORTED',
          network: NETWORK,
          message: 'LinkedIn posts are never split; shorten the text or use a LinkedIn override.',
        });
      }
      return issues;
    },

    async connectionStatus(
      account: AccountState | null,
      ctx: AdapterContext,
    ): Promise<AccountStatus> {
      const s = account?.secrets as Partial<LinkedInSecrets> | null | undefined;
      const meta = (account?.meta ?? {}) as Partial<LinkedInMeta>;
      const hasToken = !!account && account.status !== 'disconnected' && !!s?.accessToken;
      const expiresAt = s?.expiresAt ?? meta.expiresAt ?? null;
      const expired = expiresAt !== null && expiresAt <= Date.now();
      const warnings: string[] = [];
      if (hasToken && expiresAt !== null) {
        const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
        if (expired) warnings.push('Access token has expired. Reconnect LinkedIn.');
        else if (expiresAt - Date.now() < TOKEN_WARN_MS)
          warnings.push(
            `Access token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}; reconnect LinkedIn soon.`,
          );
      }
      const creds = await opts.getClientCredentials();
      if (!creds) warnings.push('LinkedIn app client id/secret are not configured in Settings.');
      const connected = hasToken && !expired;
      return {
        network: NETWORK,
        connected,
        status: connected
          ? account?.status === 'needs_auth'
            ? 'needs_auth'
            : 'connected'
          : hasToken
            ? 'needs_auth'
            : (account?.status ?? 'disconnected'),
        handle: account?.handle ?? meta.name ?? null,
        limits: ctx.limits,
        warnings,
        expiresAt,
        details: {
          personUrn: meta.personUrn ?? null,
          name: meta.name ?? null,
          hasRefreshToken: !!s?.refreshToken,
          apiVersion: LINKEDIN_VERSION,
        },
      };
    },

    async publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult> {
      const { accessToken } = secretsFrom(ctx.account);
      const owner = personUrnFrom(ctx.account);
      const part = post.parts[0];
      if (!part || post.parts.length !== 1) {
        throw new PosterError('VALIDATION', 'LinkedIn supports exactly one part per post.', {
          retryable: false,
        });
      }
      const images = part.media.filter((m) => m.kind === 'image');
      const videos = part.media.filter((m) => m.kind === 'video');
      const media: { kind: 'image' | 'video'; urn: string; altText?: string }[] = [];
      let hasVideo = false;

      if (videos.length > 0) {
        const v = videos[0] as MediaRef;
        ctx.logger.info({ mediaId: v.id }, 'Uploading video to LinkedIn');
        const urn = await uploadVideo(accessToken, owner, v, ctx);
        media.push({ kind: 'video', urn, altText: v.altText });
        hasVideo = true;
      } else {
        for (const img of images) {
          ctx.logger.info({ mediaId: img.id }, 'Uploading image to LinkedIn');
          const urn = await uploadImage(accessToken, owner, img, ctx, imagePollInterval);
          media.push({ kind: 'image', urn, altText: img.altText });
        }
      }

      const body = buildPostBody(owner, part.text, media);
      if (hasVideo && videoSettleMs > 0) {
        ctx.logger.info({ waitMs: videoSettleMs }, 'Waiting for LinkedIn to process the video');
        await sleep(videoSettleMs, ctx.signal);
      }

      let attempt = 0;
      for (;;) {
        try {
          const urn = await createPost(accessToken, body, ctx);
          return { url: linkedInPostUrl(urn), remoteIds: [urn] };
        } catch (err) {
          if (hasVideo && looksLikeStillProcessing(err) && attempt < videoBackoff.length) {
            const wait = videoBackoff[attempt] as number;
            attempt++;
            ctx.logger.warn(
              { attempt, waitMs: wait },
              'LinkedIn video not processed yet; retrying post creation',
            );
            await sleep(wait, ctx.signal);
            continue;
          }
          if (hasVideo && looksLikeStillProcessing(err)) {
            throw new PosterError(
              'UPSTREAM_ERROR',
              `LinkedIn video was still processing after ${attempt} retries: ${(err as Error).message}`,
              {
                retryable: true,
                cause: err,
              },
            );
          }
          throw err;
        }
      }
    },

    async selfTest(account: AccountState, _ctx: AdapterContext): Promise<SelfTestResult> {
      try {
        const { accessToken, expiresAt } = secretsFrom(account);
        const me = await fetchWithTimeout(`${LINKEDIN_API}/v2/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        await expectOk(me, { service: 'LinkedIn userinfo' });
        const info = await readJson<UserInfo>(me, 'LinkedIn');
        const days = Math.floor((expiresAt - Date.now()) / 86_400_000);
        return {
          ok: true,
          message: `Token valid for ${info?.name ?? info?.sub}; expires in ${days} days`,
          details: { expiresAt },
        };
      } catch (err) {
        const e = PosterError.from(err);
        return { ok: false, message: e.message, details: { code: e.code } };
      }
    },
  };
}
