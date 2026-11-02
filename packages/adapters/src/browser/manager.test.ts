import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '@poster/core';
import { BrowserManager } from './manager.js';
import { selfTestSelectors } from './selfTest.js';
import { X_SELECTORS } from '../x/x.selectors.js';
import { FARCASTER_SELECTORS } from '../farcaster/farcaster.selectors.js';

const CHROMIUM = '/opt/pw-browsers/chromium';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

/** Fixture that satisfies every `checkOnCompose` selector of the X set plus a text input. */
const X_COMPOSE_FIXTURE = `<!doctype html><html><body>
  <nav><a data-testid="SideNav_AccountSwitcher_Button" href="/home">me</a></nav>
  <div role="textbox" contenteditable="true" data-testid="tweetTextarea_0" id="box"></div>
  <input data-testid="fileInput" type="file" accept="image/*,video/*" style="display:none" />
  <button data-testid="tweetButton">Post</button>
  <input id="plain" type="text" />
  <script>
    document.getElementById('plain').addEventListener('focus', () => { window.__focused = true; });
  </script>
</body></html>`;

const FC_COMPOSE_FIXTURE = `<!doctype html><html><body>
  <a href="/~/compose">Cast</a>
  <div role="textbox" contenteditable="true" data-testid="cast-composer-textarea"></div>
  <input type="file" accept="image/*" />
  <button data-testid="cast-composer-submit" type="submit">Cast</button>
</body></html>`;

describe.skipIf(!existsSync(CHROMIUM))('BrowserManager (Chromium)', () => {
  let profiles: string;
  let manager: BrowserManager;

  beforeAll(() => {
    profiles = mkdtempSync(path.join(os.tmpdir(), 'poster-browser-test-'));
    manager = new BrowserManager({
      logger: silent,
      chromiumPath: CHROMIUM,
      typingDelayMs: { min: 0, max: 1 },
    });
  });

  afterAll(async () => {
    await manager.closeAll();
    rmSync(profiles, { recursive: true, force: true });
  });

  it('runs the selector self-test against a fixture composer and blocks hosts outside the allowlist', async () => {
    const result = await manager.withContext(
      { network: 'x', profileDir: path.join(profiles, 'x'), allowedHosts: ['x.com', 'twimg.com'] },
      async (context, page) => {
        await context.route('https://x.com/**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: X_COMPOSE_FIXTURE }),
        );
        await page.goto(X_SELECTORS.composeUrl);
        const selfTest = await selfTestSelectors(page, X_SELECTORS, 5_000);
        // A request outside the allowlist is aborted before it reaches the network.
        const blocked = await page
          .evaluate(() =>
            fetch('https://evil.example/steal').then(
              () => 'ok',
              () => 'blocked',
            ),
          )
          .catch(() => 'blocked');
        return { selfTest, blocked };
      },
    );
    expect(result.selfTest.ok).toBe(true);
    expect(result.selfTest.missing).toEqual([]);
    expect(result.blocked).toBe('blocked');
  }, 30_000);

  it('runs the Farcaster selector self-test against a fixture composer', async () => {
    const result = await manager.withContext(
      { network: 'farcaster', profileDir: path.join(profiles, 'fc') },
      async (context, page) => {
        await context.route('https://farcaster.xyz/**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: FC_COMPOSE_FIXTURE }),
        );
        await page.goto(FARCASTER_SELECTORS.composeUrl);
        return selfTestSelectors(page, FARCASTER_SELECTORS, 5_000);
      },
    );
    expect(result.ok).toBe(true);
  }, 30_000);

  it('types human-like into the composer', async () => {
    const value = await manager.withContext(
      { network: 'x', profileDir: path.join(profiles, 'x-type') },
      async (context, page) => {
        await context.route('https://x.com/**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: X_COMPOSE_FIXTURE }),
        );
        await page.goto(X_SELECTORS.composeUrl);
        await manager.typeHuman(page, '#plain', 'hello x');
        return page.inputValue('#plain');
      },
    );
    expect(value).toBe('hello x');
  }, 30_000);

  it('streams frames and replays mouse/keyboard input in a remote session', async () => {
    const frames: { width: number; height: number }[] = [];
    const states: string[] = [];
    const urls: string[] = [];
    const session = await manager.startRemoteSession({
      network: 'x',
      profileDir: path.join(profiles, 'x-remote'),
      allowedHosts: ['x.com'],
      startUrl: 'about:blank',
      idleMs: 60_000,
      onFrame: (f) => frames.push({ width: f.width, height: f.height }),
      onState: (s) => states.push(s),
      onUrl: (u) => urls.push(u),
      detectLoggedIn: async (page) => page.url().includes('/home'),
    });
    expect(manager.activeRemoteSession?.id).toBe(session.id);
    expect(manager.getRemoteSession(session.id)).toBe(session);
    expect(states).toContain('started');

    // A second session is refused while one is open.
    await expect(
      manager.startRemoteSession({
        network: 'farcaster',
        profileDir: path.join(profiles, 'fc-remote'),
        startUrl: 'about:blank',
        idleMs: 60_000,
        onFrame: () => {},
        onState: () => {},
        detectLoggedIn: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await session.context.route('https://x.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: X_COMPOSE_FIXTURE }),
    );
    await session.navigate('https://x.com/compose/post');
    await expect(session.navigate('https://evil.example/')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // Click the plain input (via its bounding box) and insert text through CDP.
    const box = await session.page.locator('#plain').boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await session.dispatchMouse({ type: 'mouseMoved', x, y });
    await session.dispatchMouse({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await session.dispatchMouse({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await session.insertText('secret-pass');
    await session.dispatchKey({ type: 'keyDown', key: '!', code: 'Digit1', text: '!' });
    await session.dispatchKey({ type: 'keyUp', key: '!', code: 'Digit1' });
    expect(await session.page.inputValue('#plain')).toBe('secret-pass!');

    // Logged-in detection flips once we land on /home.
    await session.navigate('https://x.com/home');
    await new Promise((r) => setTimeout(r, 500));
    expect(session.loggedIn).toBe(true);
    expect(states).toContain('logged_in');
    expect(urls.some((u) => u.includes('/home'))).toBe(true);

    // Frames were streamed.
    await new Promise((r) => setTimeout(r, 300));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.width).toBeGreaterThan(0);

    await session.close('test done');
    expect(states.at(-1)).toBe('closed');
    expect(manager.activeRemoteSession).toBeUndefined();
  }, 45_000);
});
