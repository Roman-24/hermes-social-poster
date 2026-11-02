/**
 * Shared Chromium for the browser-driven networks (X login/composer fallback, Farcaster).
 *
 * Design (spec: "Shared browser module"):
 *  - one persistent profile directory per network, opened on demand and closed afterwards so
 *    cookies and local storage are flushed to disk;
 *  - one global mutex: a publish, a self-test or a remote login session never run concurrently;
 *  - every context runs inside a hostname allowlist and with downloads disabled;
 *  - the remote login session streams CDP `Page.startScreencast` JPEG frames to the UI and replays
 *    mouse/keyboard input with `Input.dispatch*Event`, so 2FA and challenges can be completed from a
 *    headless VPS.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { PosterError, type Logger } from '@poster/core';
import { hostAllowed, urlAllowed } from './allowlist.js';
import type {
  BrowserManagerApi,
  BrowserManagerOptions,
  ContextRequest,
  KeyEventInput,
  MouseEventInput,
  RemoteBrowserSession,
  RemoteSessionOptions,
  RemoteSessionState,
} from './types.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TYPING = { min: 20, max: 90 };

/** Simple promise-chain mutex. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Resolves with a release function once the lock is held. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    return prev.then(() => release);
  }
}

export class BrowserManager implements BrowserManagerApi {
  private readonly logger: Logger;
  private readonly chromiumPath: string | undefined;
  private readonly typingDelay: { min: number; max: number };
  private readonly viewport: { width: number; height: number };
  private readonly extraArgs: string[];
  private readonly mutex = new Mutex();
  private remote: RemoteSession | undefined;
  /** Contexts currently open (at most one by construction, but tracked defensively). */
  private readonly openContexts = new Set<BrowserContext>();

  constructor(opts: BrowserManagerOptions) {
    this.logger = opts.logger.child({ module: 'browser' });
    this.chromiumPath = opts.chromiumPath;
    this.typingDelay = opts.typingDelayMs ?? DEFAULT_TYPING;
    this.viewport = opts.viewport ?? DEFAULT_VIEWPORT;
    this.extraArgs = opts.extraArgs ?? [];
  }

  get activeRemoteSession(): RemoteBrowserSession | undefined {
    return this.remote;
  }

  getRemoteSession(id: string): RemoteBrowserSession | undefined {
    return this.remote && this.remote.id === id ? this.remote : undefined;
  }

  async withContext<T>(
    req: ContextRequest,
    fn: (ctx: BrowserContext, page: Page) => Promise<T>,
  ): Promise<T> {
    const release = await this.mutex.acquire();
    let context: BrowserContext | undefined;
    try {
      context = await this.launch(req);
      const page = context.pages()[0] ?? (await context.newPage());
      return await fn(context, page);
    } finally {
      if (context) await this.closeContext(context);
      release();
    }
  }

  async startRemoteSession(opts: RemoteSessionOptions): Promise<RemoteBrowserSession> {
    if (this.remote) {
      throw new PosterError(
        'CONFLICT',
        'A remote browser session is already open. Close it first.',
      );
    }
    if (!urlAllowed(opts.startUrl, opts.allowedHosts)) {
      throw new PosterError('VALIDATION', `Start URL ${opts.startUrl} is outside the allowlist.`);
    }
    const release = await this.mutex.acquire();
    // Re-check after waiting on the mutex.
    if (this.remote) {
      release();
      throw new PosterError(
        'CONFLICT',
        'A remote browser session is already open. Close it first.',
      );
    }
    let context: BrowserContext | undefined;
    try {
      context = await this.launch({ ...opts, headless: true });
      const page = context.pages()[0] ?? (await context.newPage());
      const session = new RemoteSession({
        id: randomUUID(),
        context,
        page,
        opts,
        viewport: this.viewport,
        logger: this.logger,
        onClosed: async (reason) => {
          this.remote = undefined;
          this.openContexts.delete(context!);
          release();
          this.logger.info({ network: opts.network, reason }, 'remote browser session closed');
        },
      });
      this.remote = session;
      await session.start();
      return session;
    } catch (err) {
      if (context) await this.closeContext(context);
      this.remote = undefined;
      release();
      throw err;
    }
  }

  async typeHuman(page: Page, selector: string, text: string): Promise<void> {
    const locator = page.locator(selector).first();
    await locator.click();
    const { min, max } = this.typingDelay;
    // Very long texts: insert the bulk at once (like a paste), then type the tail so the
    // composer's input handlers still see keystrokes.
    const TAIL = 24;
    let head = '';
    let tail = text;
    if (text.length > 400) {
      head = text.slice(0, text.length - TAIL);
      tail = text.slice(text.length - TAIL);
    }
    if (head) {
      await page.keyboard.insertText(head);
      await page.waitForTimeout(randomBetween(80, 200));
    }
    for (const ch of tail) {
      await page.keyboard.type(ch, { delay: 0 });
      await page.waitForTimeout(randomBetween(min, max));
    }
  }

  async closeAll(): Promise<void> {
    if (this.remote) {
      await this.remote.close('shutdown').catch(() => undefined);
    }
    for (const ctx of [...this.openContexts]) {
      await this.closeContext(ctx);
    }
  }

  /* ------------------------------------------------------------------ */

  private async launch(req: ContextRequest): Promise<BrowserContext> {
    mkdirSync(req.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(req.profileDir, {
      headless: req.headless ?? true,
      viewport: this.viewport,
      executablePath: this.chromiumPath,
      proxy: req.proxy ? { server: req.proxy } : undefined,
      args: ['--disable-blink-features=AutomationControlled', ...this.extraArgs],
      acceptDownloads: false,
      locale: 'en-US',
      ignoreDefaultArgs: ['--enable-automation'],
    });
    this.openContexts.add(context);
    context.setDefaultTimeout(30_000);
    if (req.allowedHosts) {
      const allowed = req.allowedHosts;
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (urlAllowed(url, allowed)) {
          await route.continue();
        } else {
          this.logger.debug(
            { url: safeUrl(url), network: req.network },
            'blocked request outside allowlist',
          );
          await route.abort('blockedbyclient');
        }
      });
    }
    return context;
  }

  private async closeContext(context: BrowserContext): Promise<void> {
    this.openContexts.delete(context);
    try {
      await context.close();
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'closing browser context failed');
    }
  }
}

/* -------------------------------------------------------------------- */
/* Remote session                                                        */
/* -------------------------------------------------------------------- */

interface RemoteSessionDeps {
  id: string;
  context: BrowserContext;
  page: Page;
  opts: RemoteSessionOptions;
  viewport: { width: number; height: number };
  logger: Logger;
  onClosed(reason: string): Promise<void>;
}

class RemoteSession implements RemoteBrowserSession {
  readonly id: string;
  readonly network;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly createdAt = Date.now();
  loggedIn = false;

  private cdp: CDPSession | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private detecting = false;
  private readonly opts: RemoteSessionOptions;
  private readonly logger: Logger;
  private readonly viewport: { width: number; height: number };
  private readonly onClosed: (reason: string) => Promise<void>;

  constructor(deps: RemoteSessionDeps) {
    this.id = deps.id;
    this.network = deps.opts.network;
    this.page = deps.page;
    this.context = deps.context;
    this.opts = deps.opts;
    this.logger = deps.logger.child({ remoteSession: deps.id, network: deps.opts.network });
    this.viewport = deps.viewport;
    this.onClosed = deps.onClosed;
  }

  async start(): Promise<void> {
    const cdp = await this.context.newCDPSession(this.page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (frame) => {
      if (this.closed) return;
      try {
        this.opts.onFrame({
          data: frame.data,
          width: Math.round(frame.metadata.deviceWidth),
          height: Math.round(frame.metadata.deviceHeight),
        });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'onFrame handler failed');
      }
      cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.enable');
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 2,
    });

    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page.mainFrame()) return;
      this.opts.onUrl?.(frame.url());
      void this.checkLoggedIn();
    });
    this.page.on('close', () => {
      void this.close('page closed');
    });

    this.touch();
    this.pollTimer = setInterval(() => void this.checkLoggedIn(), 3_000);
    this.setState('started');

    try {
      await this.page.goto(this.opts.startUrl, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'initial navigation failed');
      this.setState('error', `Could not open ${this.opts.startUrl}: ${(err as Error).message}`);
    }
    this.opts.onUrl?.(this.page.url());
  }

  async dispatchMouse(ev: MouseEventInput): Promise<void> {
    this.touch();
    await this.cdp?.send('Input.dispatchMouseEvent', {
      type: ev.type,
      x: clamp(ev.x, 0, this.viewport.width),
      y: clamp(ev.y, 0, this.viewport.height),
      button: ev.button ?? (ev.type === 'mouseMoved' || ev.type === 'mouseWheel' ? 'none' : 'left'),
      clickCount:
        ev.clickCount ?? (ev.type === 'mousePressed' || ev.type === 'mouseReleased' ? 1 : 0),
      deltaX: ev.deltaX ?? 0,
      deltaY: ev.deltaY ?? 0,
      modifiers: ev.modifiers ?? 0,
    });
  }

  async dispatchKey(ev: KeyEventInput): Promise<void> {
    this.touch();
    const params: Record<string, unknown> = { type: ev.type, modifiers: ev.modifiers ?? 0 };
    if (ev.key !== undefined) params.key = ev.key;
    if (ev.code !== undefined) params.code = ev.code;
    if (ev.text !== undefined) params.text = ev.text;
    if (ev.windowsVirtualKeyCode !== undefined) {
      params.windowsVirtualKeyCode = ev.windowsVirtualKeyCode;
      params.nativeVirtualKeyCode = ev.windowsVirtualKeyCode;
    }
    // Printable keyDown without text would not insert anything; mirror the browser behaviour.
    if (ev.type === 'keyDown' && ev.text === undefined && ev.key && ev.key.length === 1) {
      params.text = ev.key;
    }
    await this.cdp?.send('Input.dispatchKeyEvent', params as never);
  }

  async insertText(text: string): Promise<void> {
    this.touch();
    await this.cdp?.send('Input.insertText', { text });
  }

  async navigate(url: string): Promise<void> {
    this.touch();
    if (!urlAllowed(url, this.opts.allowedHosts)) {
      throw new PosterError('FORBIDDEN', `Navigation to ${safeUrl(url)} is outside the allowlist.`);
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch((err: Error) => {
      this.logger.warn({ err: err.message }, 'navigation failed');
    });
  }

  touch(): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close('idle'), this.opts.idleMs);
  }

  async close(reason = 'closed'): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.closed = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.pollTimer) clearInterval(this.pollTimer);
      try {
        await this.cdp?.send('Page.stopScreencast').catch(() => undefined);
        await this.cdp?.detach().catch(() => undefined);
      } finally {
        await this.context.close().catch(() => undefined);
        this.setState('closed', reason);
        await this.onClosed(reason);
      }
    })();
    return this.closing;
  }

  /* ---------------------------------------------------------------- */

  private setState(state: RemoteSessionState, message?: string): void {
    try {
      this.opts.onState(state, message);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'onState handler failed');
    }
  }

  private async checkLoggedIn(): Promise<void> {
    if (this.closed || this.loggedIn || this.detecting) return;
    this.detecting = true;
    try {
      if (await this.opts.detectLoggedIn(this.page)) {
        this.loggedIn = true;
        this.setState('logged_in');
      }
    } catch {
      // Page is navigating; try again on the next tick.
    } finally {
      this.detecting = false;
    }
  }
}

/* -------------------------------------------------------------------- */

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
}

/** Strip query strings before logging (they can carry tokens). */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

export { hostAllowed, urlAllowed };
