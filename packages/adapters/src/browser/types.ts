import type { BrowserContext, Page } from 'playwright-core';
import type { Logger, Network } from '@poster/core';

export interface BrowserManagerOptions {
  logger: Logger;
  /** Explicit Chromium binary; undefined lets playwright-core resolve it (PLAYWRIGHT_BROWSERS_PATH). */
  chromiumPath?: string;
  /** Human-like typing delay range in ms. */
  typingDelayMs?: { min: number; max: number };
  /** Default viewport for all contexts (also the remote screencast size). */
  viewport?: { width: number; height: number };
  /** Extra Chromium args (e.g. for rootless Podman: --no-sandbox is NOT needed with user namespaces). */
  extraArgs?: string[];
}

export interface ContextRequest {
  network: Network;
  /** Absolute path of the persistent profile directory for this network. Created if missing. */
  profileDir: string;
  /** Optional proxy, e.g. socks5://100.64.0.1:1055 (Tailscale exit node at home). */
  proxy?: string | null;
  /** Hostnames allowed for navigation; anything else is aborted. */
  allowedHosts?: string[];
  headless?: boolean;
}

export type RemoteSessionState = 'started' | 'logged_in' | 'saved' | 'closed' | 'error';

export interface RemoteSessionOptions extends ContextRequest {
  startUrl: string;
  /** Idle timeout after which the session closes itself. */
  idleMs: number;
  /** Called with each JPEG frame (base64) from CDP Page.screencastFrame. */
  onFrame(frame: { data: string; width: number; height: number }): void;
  onState(state: RemoteSessionState, message?: string): void;
  onUrl?(url: string): void;
  /** Polled after navigations and every few seconds; true flips the session to logged_in. */
  detectLoggedIn(page: Page): Promise<boolean>;
}

export interface MouseEventInput {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'none' | 'left' | 'middle' | 'right';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface KeyEventInput {
  type: 'keyDown' | 'keyUp' | 'char';
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
  windowsVirtualKeyCode?: number;
}

export interface RemoteBrowserSession {
  readonly id: string;
  readonly network: Network;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly createdAt: number;
  readonly loggedIn: boolean;
  dispatchMouse(ev: MouseEventInput): Promise<void>;
  dispatchKey(ev: KeyEventInput): Promise<void>;
  /** Paste text at the focused element (passwords, 2FA codes). */
  insertText(text: string): Promise<void>;
  /** Allowlist-checked navigation. */
  navigate(url: string): Promise<void>;
  /** Reset the idle timer. */
  touch(): void;
  /** Stop the screencast and close the context; the profile stays on disk. */
  close(reason?: string): Promise<void>;
}

export interface BrowserManagerApi {
  /**
   * Run `fn` with exclusive access to the network's persistent context. Serialises all browser work
   * (one publish at a time) and closes the context afterwards so cookies are flushed to disk.
   */
  withContext<T>(
    req: ContextRequest,
    fn: (ctx: BrowserContext, page: Page) => Promise<T>,
  ): Promise<T>;
  /** Start a remote login session. Rejects with CONFLICT if one is already open. */
  startRemoteSession(opts: RemoteSessionOptions): Promise<RemoteBrowserSession>;
  getRemoteSession(id: string): RemoteBrowserSession | undefined;
  readonly activeRemoteSession: RemoteBrowserSession | undefined;
  /** Human-like typing into a locator. */
  typeHuman(page: Page, selector: string, text: string): Promise<void>;
  /** Close everything (shutdown). */
  closeAll(): Promise<void>;
}
