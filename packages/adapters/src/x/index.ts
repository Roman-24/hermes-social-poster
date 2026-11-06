/**
 * X adapter.
 *
 * Posting goes through rettiwt-api (X's internal web API) using the cookies of your own login,
 * because the official API is paid. You log in once in the remote browser view; the adapter
 * captures `auth_token`/`ct0`/`twid`, encodes them as rettiwt's API key and stores them encrypted.
 *
 * Risks (spec "Risks"): X's internal API changes without notice and cookie-based posting can get an
 * account limited; the adapter pins rettiwt, runs a read-only nightly self-test, keeps volume low and
 * offers a Playwright composer fallback behind `settings.x.composerFallback`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { Rettiwt } from 'rettiwt-api';
import {
  DEFAULT_LIMITS,
  PartialPublishError,
  PosterError,
  validateAgainstLimits,
  type AccountState,
  type AccountStatus,
  type AdapterContext,
  type ConnectResult,
  type Issue,
  type NetworkAdapter,
  type PublishCtx,
  type PublishResult,
  type RenderedPart,
  type RenderedPost,
  type SelfTestResult,
} from '@poster/core';
import type { BrowserManagerApi } from '../browser/types.js';
import { anyVisible, selfTestSelectors } from '../browser/selfTest.js';
import {
  cookiesToApiKey,
  pickStorableCookies,
  userIdFromTwid,
  type CookieLike,
} from './cookies.js';
import { mapXError } from './errors.js';
import { X_ALLOWED_HOSTS, X_SELECTORS } from './x.selectors.js';

interface XSecrets {
  apiKey: string;
  cookies?: CookieLike[];
}

interface XMeta {
  userId?: string;
  userName?: string;
  capturedAt?: number;
}

function secretsOf(account: AccountState | null): XSecrets | null {
  const s = account?.secrets as Partial<XSecrets> | null | undefined;
  return s && typeof s.apiKey === 'string' ? (s as XSecrets) : null;
}

function metaOf(account: AccountState | null): XMeta {
  return (account?.meta ?? {}) as XMeta;
}

function statusUrl(userName: string | undefined, id: string): string {
  return `https://x.com/${userName ?? 'i'}/status/${id}`;
}

function normalizeText(t: string): string {
  return t
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .trim()
    .toLowerCase();
}

export function createXAdapter(browser: BrowserManagerApi): NetworkAdapter {
  const makeClient = (account: AccountState): Rettiwt => {
    const secrets = secretsOf(account);
    if (!secrets)
      throw new PosterError('AUTH_REQUIRED', 'X is not connected. Log in via Accounts → X.');
    return new Rettiwt({
      apiKey: secrets.apiKey,
      proxy: account.proxy ?? undefined,
      timeout: 60_000,
      maxRetries: 0,
    });
  };

  /**
   * Look for the tweet THIS attempt just created when X returned no id. A match must be a plain
   * tweet by this account, created after the attempt started (minus a little clock skew), not one
   * already recorded for this thread, with exactly the same normalised, non-empty text. Anything
   * weaker (an older identical tweet, a prefix match, a retweet, "any item" for a media-only part)
   * would record a post that was never made as published and attach later thread parts to it.
   * When in doubt this returns null and the target stays UNKNOWN_OUTCOME for the operator.
   */
  const findRecent = async (
    text: string,
    account: AccountState,
    _ctx: AdapterContext,
    opts: { notBefore: number; known: readonly string[] } = {
      notBefore: Date.now() - 5 * 60_000,
      known: [],
    },
  ): Promise<{ url: string; remoteId: string } | null> => {
    const meta = metaOf(account);
    if (!meta.userId) return null;
    const wanted = normalizeText(text);
    if (!wanted) return null; // media-only parts cannot be matched by text
    try {
      const client = makeClient(account);
      const timeline = await client.user.timeline(meta.userId, 20);
      for (const tweet of timeline.list) {
        if (opts.known.includes(tweet.id)) continue;
        if (tweet.retweetedTweet || tweet.tweetBy?.id !== meta.userId) continue;
        const created = Date.parse(tweet.createdAt);
        if (!Number.isFinite(created) || created < opts.notBefore) continue;
        if (normalizeText(tweet.fullText) !== wanted) continue;
        return { url: tweet.url || statusUrl(meta.userName, tweet.id), remoteId: tweet.id };
      }
    } catch {
      // Best-effort only.
    }
    return null;
  };

  /** Publish one part with rettiwt. Returns the new tweet id. */
  const postPartWithRettiwt = async (
    client: Rettiwt,
    part: RenderedPart,
    replyTo: string | undefined,
    ctx: PublishCtx,
  ): Promise<string> => {
    const mediaIds: string[] = [];
    for (const m of part.media) {
      ctx.logger.debug({ mediaId: m.id, mime: m.mime, bytes: m.bytes }, 'uploading media to X');
      mediaIds.push(await client.tweet.upload(m.path));
    }
    const id = await client.tweet.post({
      text: part.text,
      media: mediaIds.length ? mediaIds.map((mid) => ({ id: mid })) : undefined,
      replyTo,
    });
    if (!id) {
      throw new PosterError(
        'UNKNOWN_OUTCOME',
        'X accepted the request but returned no tweet id. Check your profile before retrying.',
        {
          retryable: false,
        },
      );
    }
    return id;
  };

  /** Playwright composer fallback for one part. */
  const postPartWithComposer = async (
    part: RenderedPart,
    replyToUrl: string | undefined,
    account: AccountState,
    ctx: PublishCtx,
  ): Promise<string> => {
    if (!account.browserProfileDir) {
      throw new PosterError(
        'AUTH_REQUIRED',
        'No X browser profile on disk; log in again via Accounts → X.',
      );
    }
    const meta = metaOf(account);
    const sel = X_SELECTORS.selectors;
    return browser.withContext(
      {
        network: 'x',
        profileDir: account.browserProfileDir,
        proxy: account.proxy,
        allowedHosts: X_ALLOWED_HOSTS,
        headless: true,
      },
      async (_context, page) => {
        const target = replyToUrl ?? X_SELECTORS.composeUrl;
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        if (await anyVisible(page, sel.loginForm!.css, 2_500)) {
          throw new PosterError(
            'AUTH_REQUIRED',
            'X session is logged out. Log in again via Accounts → X.',
          );
        }
        if (replyToUrl) {
          // Open the inline reply composer on the status page.
          await page.locator(sel.replyComposerTextbox!.css).first().click({ timeout: 15_000 });
        }
        await page
          .locator(sel.composerTextbox!.css)
          .first()
          .waitFor({ state: 'visible', timeout: 20_000 });
        await browser.typeHuman(page, sel.composerTextbox!.css, part.text);
        if (part.media.length) {
          await page
            .locator(sel.mediaInput!.css)
            .first()
            .setInputFiles(part.media.map((m) => m.path));
          // Wait for upload previews to settle.
          await page.waitForTimeout(1_500 + 1_000 * part.media.length);
        }
        const button = page.locator(sel.postButton!.css).first();
        await button.waitFor({ state: 'visible', timeout: 10_000 });
        await button.click();
        const toastOrNav = await Promise.race([
          page
            .locator(sel.toast!.css)
            .first()
            .waitFor({ state: 'visible', timeout: 20_000 })
            .then(() => 'toast'),
          page
            .waitForURL((u) => !u.pathname.startsWith('/compose'), { timeout: 20_000 })
            .then(() => 'nav'),
        ]).catch(() => null);
        if (!toastOrNav) {
          await saveDebugScreenshot(page, ctx, 'x-composer-timeout');
          throw new PosterError(
            'UNKNOWN_OUTCOME',
            'Clicked Post but saw no confirmation. Check your X profile before retrying.',
            {
              retryable: false,
            },
          );
        }
        // Read the newest status id from the profile page.
        const userName = meta.userName;
        if (!userName) {
          throw new PosterError(
            'UNKNOWN_OUTCOME',
            'Posted via composer but the account user name is unknown; cannot read the post URL.',
            {
              retryable: false,
            },
          );
        }
        await page.goto(`https://x.com/${userName}`, { waitUntil: 'domcontentloaded' });
        const link = page.locator(sel.profileStatusLink!.css).first();
        await link.waitFor({ state: 'attached', timeout: 20_000 });
        const href = await link.locator('xpath=..').getAttribute('href');
        const id = href ? /\/status\/(\d+)/.exec(href)?.[1] : undefined;
        if (!id) {
          await saveDebugScreenshot(page, ctx, 'x-profile-no-status');
          throw new PosterError(
            'UNKNOWN_OUTCOME',
            'Posted via composer but could not read the new status id from the profile.',
            {
              retryable: false,
            },
          );
        }
        return id;
      },
    );
  };

  const saveDebugScreenshot = async (
    page: Page,
    ctx: PublishCtx,
    label: string,
  ): Promise<string | undefined> => {
    if (!ctx.settings.browser.keepDebugScreenshots) return undefined;
    try {
      mkdirSync(ctx.debugDir, { recursive: true });
      const file = path.join(ctx.debugDir, `${ctx.attemptKey}-${label}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'could not save debug screenshot');
      return undefined;
    }
  };

  const adapter: NetworkAdapter = {
    id: 'x',
    capabilities: DEFAULT_LIMITS.x,

    connect: {
      kind: 'browser',
      startUrl: 'https://x.com/login',
      allowedHosts: X_ALLOWED_HOSTS,
      async detectLoggedIn(pageLike) {
        const page = pageLike as unknown as Page;
        const url = page.url();
        if (/^https:\/\/(x|twitter)\.com\/home/.test(url)) return true;
        if (/\/(login|i\/flow)/.test(url)) return false;
        return anyVisible(page, X_SELECTORS.selectors.loggedInIndicator!.css, 800);
      },
      async capture(pageLike, ctx): Promise<ConnectResult> {
        const page = pageLike as unknown as Page;
        const cookies = (await page
          .context()
          .cookies(['https://x.com', 'https://twitter.com'])) as CookieLike[];
        let apiKey: string;
        try {
          apiKey = cookiesToApiKey(cookies);
        } catch (err) {
          throw new PosterError(
            'AUTH_REQUIRED',
            `${(err as Error).message}. Finish logging in, then press Save.`,
          );
        }
        const twid = cookies.find((c) => c.name === 'twid')?.value;
        let userId = userIdFromTwid(twid) ?? undefined;
        let userName: string | undefined;
        try {
          const me = await new Rettiwt({ apiKey, timeout: 30_000, maxRetries: 0 }).user.details();
          if (me) {
            userName = me.userName;
            userId = me.id ?? userId;
          }
        } catch (err) {
          ctx.logger.warn(
            { err: (err as Error).message },
            'rettiwt could not fetch the logged-in user; falling back to twid',
          );
        }
        const warnings: string[] = [];
        if (!userName)
          warnings.push(
            'Could not read your X user name via rettiwt; post URLs will use /i/status/<id>.',
          );
        return {
          handle: userName ? `@${userName}` : null,
          secrets: { apiKey, cookies: pickStorableCookies(cookies) } satisfies XSecrets,
          meta: { userId, userName, capturedAt: Date.now() } satisfies XMeta,
          warnings,
        };
      },
    },

    validate(post: RenderedPost, _account: AccountState | null, ctx: AdapterContext): Issue[] {
      const issues = validateAgainstLimits(post, ctx.limits);
      post.parts.forEach((part, idx) => {
        for (const m of part.media) {
          if (m.kind === 'image' && m.mime === 'image/webp') {
            issues.push({
              level: 'warning',
              code: 'IMAGE_WILL_CONVERT',
              network: 'x',
              part: idx,
              mediaId: m.id,
              message: 'WebP is converted to JPEG/PNG for X.',
            });
          }
        }
      });
      return issues;
    },

    async connectionStatus(
      account: AccountState | null,
      ctx: AdapterContext,
    ): Promise<AccountStatus> {
      const secrets = secretsOf(account);
      const meta = metaOf(account);
      const connected = !!secrets && account?.status !== 'needs_auth';
      const warnings: string[] = [];
      if (account?.status === 'needs_auth')
        warnings.push('X rejected the stored session. Log in again.');
      if (connected && !account?.browserProfileDir)
        warnings.push('No browser profile on disk: the composer fallback is unavailable.');
      return {
        network: 'x',
        connected,
        status: connected ? 'connected' : account ? account.status : 'disconnected',
        handle: account?.handle ?? null,
        limits: ctx.limits,
        warnings,
        expiresAt: null,
        details: {
          userName: meta.userName ?? null,
          userId: meta.userId ?? null,
          capturedAt: meta.capturedAt ?? null,
          rettiwtVersion: ctx.settings.x.rettiwtVersion,
          composerFallback: ctx.settings.x.composerFallback,
        },
      };
    },

    async publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult> {
      const account = ctx.account;
      const meta = metaOf(account);
      const client = makeClient(account);
      const remoteIds: string[] = [...(post.publishedRemoteIds ?? [])];
      const startAt = remoteIds.length;

      for (let i = startAt; i < post.parts.length; i++) {
        const part = post.parts[i]!;
        const replyTo = i > 0 ? remoteIds[i - 1] : undefined;
        ctx.signal?.throwIfAborted();
        let id: string;
        const attemptedAt = Date.now();
        try {
          id = await postPartWithRettiwt(client, part, replyTo, ctx);
        } catch (rawErr) {
          const err = mapXError(rawErr);
          if (err.code === 'UNKNOWN_OUTCOME') {
            const found = await findRecent(part.text, account, ctx, {
              notBefore: attemptedAt - 60_000,
              known: remoteIds,
            });
            if (found) {
              id = found.remoteId;
              ctx.logger.warn(
                { part: i, id },
                'X returned no id but the tweet was found on the timeline',
              );
              remoteIds.push(id);
              continue;
            }
            if (remoteIds.length > startAt) throw new PartialPublishError(remoteIds, i, err);
            throw err;
          }
          if (err.code === 'AUTH_REQUIRED') {
            await ctx.updateAccount({ status: 'needs_auth' });
            if (remoteIds.length > startAt) throw new PartialPublishError(remoteIds, i, err);
            throw err;
          }
          const canFallback =
            ctx.settings.x.composerFallback &&
            !err.retryable &&
            err.code !== 'RATE_LIMITED' &&
            !!account.browserProfileDir;
          if (!canFallback) {
            if (remoteIds.length > startAt) throw new PartialPublishError(remoteIds, i, err);
            throw err;
          }
          ctx.logger.warn(
            { err: err.message, part: i },
            'rettiwt failed; using the Playwright composer fallback',
          );
          try {
            const replyToUrl = replyTo ? statusUrl(meta.userName, replyTo) : undefined;
            id = await postPartWithComposer(part, replyToUrl, account, ctx);
          } catch (fallbackErr) {
            const fe = PosterError.from(fallbackErr, 'UPSTREAM_ERROR');
            if (fe.code === 'AUTH_REQUIRED') await ctx.updateAccount({ status: 'needs_auth' });
            if (remoteIds.length > startAt) throw new PartialPublishError(remoteIds, i, fe);
            throw fe;
          }
        }
        remoteIds.push(id);
      }

      const first = remoteIds[0];
      return {
        url: first ? statusUrl(meta.userName, first) : undefined,
        remoteIds,
        debug: { via: 'rettiwt', parts: post.parts.length },
      };
    },

    async selfTest(account: AccountState, _ctx: AdapterContext): Promise<SelfTestResult> {
      const details: Record<string, unknown> = {};
      try {
        const me = await makeClient(account).user.details();
        details.auth = me ? `ok (@${me.userName})` : 'no user returned';
        if (!me)
          return { ok: false, message: 'rettiwt returned no user for the stored session', details };
      } catch (err) {
        const mapped = mapXError(err);
        return {
          ok: false,
          message: `rettiwt auth check failed: ${mapped.message}`,
          details: { ...details, code: mapped.code },
        };
      }
      if (account.browserProfileDir) {
        try {
          const result = await browser.withContext(
            {
              network: 'x',
              profileDir: account.browserProfileDir,
              proxy: account.proxy,
              allowedHosts: X_ALLOWED_HOSTS,
              headless: true,
            },
            async (_c, page) => {
              await page.goto(X_SELECTORS.composeUrl, { waitUntil: 'domcontentloaded' });
              if (await anyVisible(page, X_SELECTORS.selectors.loginForm!.css, 2_000)) {
                return {
                  ok: false,
                  version: X_SELECTORS.version,
                  checked: [],
                  missing: [],
                  loggedOut: true,
                };
              }
              return selfTestSelectors(page, X_SELECTORS);
            },
          );
          details.selectors = result;
          if (result.loggedOut)
            return {
              ok: false,
              message: 'Browser profile is logged out (composer fallback unavailable)',
              details,
            };
          if (!result.ok)
            return {
              ok: false,
              message: `X selectors missing: ${result.missing.join(', ')}`,
              details,
            };
        } catch (err) {
          return {
            ok: false,
            message: `Composer self-test failed: ${(err as Error).message}`,
            details,
          };
        }
      }
      return { ok: true, message: `X OK (${details.auth as string})`, details };
    },

    findRecent,
  };

  return adapter;
}
