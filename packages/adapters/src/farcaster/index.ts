/**
 * Farcaster adapter: Playwright drives the farcaster.xyz web composer in its own persistent profile.
 *
 * Why a browser (spec "Network adapters"): without Neynar, protocol-native posting needs a Snapchain
 * node with ~2 TB of disk, which the VPS does not have. You sign in once in the remote browser view
 * (approving the login in the Farcaster phone app); the session lives in the profile directory.
 *
 * Fragility: as brittle as X's automation. Selectors are in one versioned file and the nightly
 * self-test opens the composer without posting. A protocol-native adapter can replace this behind
 * the same interface later.
 *
 * Video: the web composer's video support is unverified (Milestone 4 open question), so
 * `capabilities.video` is null and videos are skipped with a preview warning.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
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
import { FARCASTER_ALLOWED_HOSTS, FARCASTER_SELECTORS } from './farcaster.selectors.js';

interface FarcasterMeta {
  username?: string;
  fid?: number;
  capturedAt?: number;
}

const SEL = FARCASTER_SELECTORS.selectors;
const HASH_RE = /\/(0x[0-9a-fA-F]{8,64})(?:[/?#]|$)/;

function metaOf(account: AccountState | null): FarcasterMeta {
  return (account?.meta ?? {}) as FarcasterMeta;
}

function castUrl(username: string, hash: string): string {
  return `https://farcaster.xyz/${username}/${hash}`;
}

/** Try to read the signed-in username from the page (profile link in the nav or settings page). */
async function readUsername(page: Page): Promise<string | undefined> {
  // 1. Settings page: a link to the user's own profile or an explicit username element.
  try {
    await page.goto('https://farcaster.xyz/~/settings', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    const text = await page
      .locator(SEL.settingsUsername!.css)
      .first()
      .textContent({ timeout: 5_000 })
      .catch(() => null);
    const m = text ? /@([a-z0-9][a-z0-9.-]{0,31})/i.exec(text) : null;
    if (m?.[1]) return m[1].toLowerCase();
  } catch {
    // fall through
  }
  // 2. Any nav link that looks like /<username> (not /~/…) with an avatar image inside.
  try {
    const hrefs = await page
      .locator('a[href^="/"]:has(img)')
      .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''));
    for (const h of hrefs) {
      const m = /^\/([a-z0-9][a-z0-9.-]{0,31})\/?$/i.exec(h);
      if (m?.[1] && m[1] !== '~') return m[1].toLowerCase();
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function createFarcasterAdapter(browser: BrowserManagerApi): NetworkAdapter {
  const saveDebugScreenshot = async (
    page: Page,
    ctx: PublishCtx,
    label: string,
  ): Promise<string | undefined> => {
    if (!ctx.settings.browser.keepDebugScreenshots) return undefined;
    try {
      mkdirSync(ctx.debugDir, { recursive: true });
      const file = path.join(ctx.debugDir, `${ctx.attemptKey}-${label}.png`);
      await page.screenshot({ path: file });
      return file;
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'could not save debug screenshot');
      return undefined;
    }
  };

  const assertSignedIn = async (page: Page): Promise<void> => {
    const composerVisible = await anyVisible(page, SEL.composerTextbox!.css, 6_000);
    if (composerVisible) return;
    if (await anyVisible(page, SEL.signInIndicator!.css, 2_000)) {
      throw new PosterError(
        'AUTH_REQUIRED',
        'farcaster.xyz session is signed out. Log in again via Accounts → Farcaster.',
      );
    }
    throw new PosterError(
      'SELECTOR_BROKEN',
      `Farcaster composer not found (selectors ${FARCASTER_SELECTORS.version}).`,
      { retryable: false },
    );
  };

  /** Newest cast hash on the profile page whose text starts like `text`. */
  const readNewestCast = async (
    page: Page,
    username: string,
    text: string,
  ): Promise<{ hash: string; url: string } | null> => {
    await page.goto(`https://farcaster.xyz/${username}`, { waitUntil: 'domcontentloaded' });
    await page
      .locator(SEL.profileCastLink!.css)
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .catch(() => undefined);
    const hrefs = await page
      .locator(SEL.profileCastLink!.css)
      .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''));
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();
    // Prefer a cast link whose surrounding article contains the snippet; else the first link.
    for (const href of hrefs) {
      const m = HASH_RE.exec(href);
      if (!m) continue;
      const hash = m[1]!;
      const article = page
        .locator(`a[href*="${hash}"]`)
        .first()
        .locator('xpath=ancestor::*[self::article or self::div][1]');
      const body = (await article.textContent().catch(() => '')) ?? '';
      if (!snippet || body.replace(/\s+/g, ' ').toLowerCase().includes(snippet)) {
        return { hash, url: castUrl(username, hash) };
      }
    }
    const first = hrefs.map((h) => HASH_RE.exec(h)?.[1]).find(Boolean);
    return first ? { hash: first, url: castUrl(username, first) } : null;
  };

  const publishPart = async (
    page: Page,
    part: RenderedPart,
    replyToUrl: string | undefined,
    username: string,
    ctx: PublishCtx,
  ): Promise<string> => {
    if (replyToUrl) {
      await page.goto(replyToUrl, { waitUntil: 'domcontentloaded' });
      const reply = page.locator(SEL.replyButton!.css).first();
      await reply.waitFor({ state: 'visible', timeout: 20_000 });
      await reply.click();
    } else {
      await page.goto(FARCASTER_SELECTORS.composeUrl, { waitUntil: 'domcontentloaded' });
    }
    await assertSignedIn(page);
    await browser.typeHuman(page, SEL.composerTextbox!.css, part.text);

    const images = part.media.filter((m) => m.kind === 'image');
    const videos = part.media.filter((m) => m.kind === 'video');
    if (videos.length)
      ctx.logger.warn(
        { count: videos.length },
        'Farcaster: video skipped (web composer unverified)',
      );
    if (images.length) {
      const input = page.locator(SEL.mediaInput!.css).first();
      await input.setInputFiles(images.map((m) => m.path));
      await page.waitForTimeout(2_000 + 1_500 * images.length);
    }

    const button = page.locator(SEL.castButton!.css).first();
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    await button.click();
    // Composer closes / text area empties / navigation.
    const settled = await Promise.race([
      page
        .locator(SEL.composerTextbox!.css)
        .first()
        .waitFor({ state: 'detached', timeout: 20_000 })
        .then(() => true),
      page
        .waitForURL((u) => !u.pathname.includes('/~/compose'), { timeout: 20_000 })
        .then(() => true),
      page.waitForTimeout(20_000).then(() => false),
    ]).catch(() => false);
    if (!settled) {
      await saveDebugScreenshot(page, ctx, 'farcaster-cast-timeout');
      throw new PosterError(
        'UNKNOWN_OUTCOME',
        'Clicked Cast but the composer did not close. Check your Farcaster profile before retrying.',
        {
          retryable: false,
        },
      );
    }
    await page.waitForTimeout(1_500);
    const found = await readNewestCast(page, username, part.text);
    if (!found) {
      await saveDebugScreenshot(page, ctx, 'farcaster-no-cast-link');
      throw new PosterError(
        'UNKNOWN_OUTCOME',
        'Cast submitted but no new cast link found on the profile page.',
        { retryable: false },
      );
    }
    return found.hash;
  };

  const adapter: NetworkAdapter = {
    id: 'farcaster',
    capabilities: DEFAULT_LIMITS.farcaster,

    connect: {
      kind: 'browser',
      startUrl: 'https://farcaster.xyz/~/signin',
      allowedHosts: FARCASTER_ALLOWED_HOSTS,
      async detectLoggedIn(pageLike) {
        const page = pageLike as unknown as Page;
        if (/\/~\/signin|\/login/.test(page.url())) return false;
        return anyVisible(page, SEL.loggedInIndicator!.css, 800);
      },
      async capture(pageLike, ctx): Promise<ConnectResult> {
        const page = pageLike as unknown as Page;
        if (!(await anyVisible(page, SEL.loggedInIndicator!.css, 3_000))) {
          throw new PosterError(
            'AUTH_REQUIRED',
            'Not signed in yet. Approve the login in the Farcaster app, then press Save.',
          );
        }
        const username = await readUsername(page);
        const warnings: string[] = [];
        if (!username)
          warnings.push(
            'Could not read your Farcaster username; set it in Accounts → Farcaster before posting.',
          );
        ctx.logger.info({ username }, 'farcaster session captured');
        return {
          handle: username ? `@${username}` : null,
          // The real session lives in the persistent profile directory; this just marks "connected".
          secrets: { profile: true, capturedAt: Date.now() },
          meta: { username, capturedAt: Date.now() } satisfies FarcasterMeta,
          warnings,
        };
      },
    },

    validate(post: RenderedPost, _account: AccountState | null, ctx: AdapterContext): Issue[] {
      const issues = validateAgainstLimits(post, ctx.limits).filter(
        (i) => i.code !== 'VIDEO_UNSUPPORTED',
      );
      post.parts.forEach((part, idx) => {
        if (part.media.some((m) => m.kind === 'video')) {
          issues.push({
            level: 'warning',
            code: 'FARCASTER_VIDEO_SKIPPED',
            network: 'farcaster',
            part: idx,
            message:
              'Video is not published to Farcaster (web composer video support is unverified); the cast goes out without it.',
          });
        }
      });
      return issues;
    },

    async connectionStatus(
      account: AccountState | null,
      ctx: AdapterContext,
    ): Promise<AccountStatus> {
      const meta = metaOf(account);
      const connected =
        !!account?.secrets && !!account.browserProfileDir && account.status !== 'needs_auth';
      const warnings: string[] = [];
      if (account?.status === 'needs_auth')
        warnings.push('farcaster.xyz signed the session out. Log in again.');
      if (connected && !meta.username)
        warnings.push('Username unknown; publishing cannot read back the cast URL.');
      return {
        network: 'farcaster',
        connected,
        status: connected ? 'connected' : account ? account.status : 'disconnected',
        handle: account?.handle ?? null,
        limits: ctx.limits,
        warnings,
        expiresAt: null,
        details: {
          username: meta.username ?? null,
          fid: meta.fid ?? null,
          capturedAt: meta.capturedAt ?? null,
          selectorsVersion: FARCASTER_SELECTORS.version,
        },
      };
    },

    async publish(post: RenderedPost, ctx: PublishCtx): Promise<PublishResult> {
      const account = ctx.account;
      const meta = metaOf(account);
      if (!account.browserProfileDir) {
        throw new PosterError(
          'AUTH_REQUIRED',
          'Farcaster is not connected (no browser profile). Log in via Accounts → Farcaster.',
        );
      }
      const username = meta.username;
      if (!username) {
        throw new PosterError(
          'NOT_CONNECTED',
          'Farcaster username unknown; reconnect the account so the handle can be read.',
          { retryable: false },
        );
      }
      const remoteIds: string[] = [...(post.publishedRemoteIds ?? [])];
      const startAt = remoteIds.length;

      return browser.withContext(
        {
          network: 'farcaster',
          profileDir: account.browserProfileDir,
          proxy: account.proxy,
          allowedHosts: FARCASTER_ALLOWED_HOSTS,
          headless: true,
        },
        async (_context, page) => {
          for (let i = startAt; i < post.parts.length; i++) {
            ctx.signal?.throwIfAborted();
            const part = post.parts[i]!;
            const replyToUrl = i > 0 ? castUrl(username, remoteIds[i - 1]!) : undefined;
            try {
              remoteIds.push(await publishPart(page, part, replyToUrl, username, ctx));
            } catch (rawErr) {
              const err = PosterError.from(rawErr, 'UPSTREAM_ERROR');
              if (err.code === 'AUTH_REQUIRED') await ctx.updateAccount({ status: 'needs_auth' });
              if (remoteIds.length > startAt) throw new PartialPublishError(remoteIds, i, err);
              throw err;
            }
          }
          const first = remoteIds[0];
          return {
            url: first ? castUrl(username, first) : undefined,
            remoteIds,
            debug: { via: 'farcaster.xyz composer', selectors: FARCASTER_SELECTORS.version },
          };
        },
      );
    },

    async selfTest(account: AccountState, _ctx: AdapterContext): Promise<SelfTestResult> {
      if (!account.browserProfileDir)
        return { ok: false, message: 'No Farcaster browser profile on disk.' };
      try {
        const result = await browser.withContext(
          {
            network: 'farcaster',
            profileDir: account.browserProfileDir,
            proxy: account.proxy,
            allowedHosts: FARCASTER_ALLOWED_HOSTS,
            headless: true,
          },
          async (_c, page) => {
            await page.goto(FARCASTER_SELECTORS.composeUrl, { waitUntil: 'domcontentloaded' });
            if (
              !(await anyVisible(page, SEL.composerTextbox!.css, 6_000)) &&
              (await anyVisible(page, SEL.signInIndicator!.css, 2_000))
            ) {
              return {
                ok: false,
                version: FARCASTER_SELECTORS.version,
                checked: [],
                missing: [],
                loggedOut: true,
              };
            }
            return selfTestSelectors(page, FARCASTER_SELECTORS);
          },
        );
        if (result.loggedOut)
          return {
            ok: false,
            message: 'farcaster.xyz session is signed out',
            details: { ...result },
          };
        if (!result.ok)
          return {
            ok: false,
            message: `Farcaster selectors missing: ${result.missing.join(', ')}`,
            details: { ...result },
          };
        return {
          ok: true,
          message: `Farcaster composer OK (selectors ${result.version})`,
          details: { ...result },
        };
      } catch (err) {
        return { ok: false, message: `Farcaster self-test failed: ${(err as Error).message}` };
      }
    },

    async testPost(account: AccountState, ctx: PublishCtx): Promise<PublishResult> {
      const post: RenderedPost = {
        postId: `test-${ctx.attemptKey}`,
        targetId: `test-${ctx.attemptKey}`,
        network: 'farcaster',
        parts: [
          { text: `Test cast from hermes-social-poster (${new Date().toISOString()})`, media: [] },
        ],
        scheduledAtUtc: Date.now(),
        thread: false,
      };
      return adapter.publish(post, { ...ctx, account });
    },
  };

  return adapter;
}
