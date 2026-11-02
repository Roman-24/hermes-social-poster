import { mkdirSync } from 'node:fs';
import { newId, PosterError, type Network } from '@poster/core';
import type {
  BrowserManagerApi,
  KeyEventInput,
  MouseEventInput,
  RemoteBrowserSession,
  RemoteSessionState,
} from '@poster/adapters';
import type { Logger } from '../logger.js';
import type { AccountService } from './accounts.js';
import type { EventBus } from './events.js';
import type { SettingsService } from './settings.js';

export type BrowserClientMessage =
  | ({ type: 'mouse'; event: MouseEventInput['type'] } & Omit<MouseEventInput, 'type'>)
  | ({ type: 'key'; event: KeyEventInput['type'] } & Omit<KeyEventInput, 'type'>)
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'save' }
  | { type: 'close' };

export type BrowserServerMessage =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'state'; state: RemoteSessionState; message?: string }
  | { type: 'url'; url: string };

interface Managed {
  id: string;
  network: Network;
  session: RemoteBrowserSession | null;
  subscribers: Set<(msg: BrowserServerMessage) => void>;
  lastFrame: BrowserServerMessage | null;
  state: RemoteSessionState;
  saving: boolean;
}

/**
 * Bridges the UI WebSocket (/ws/browser/:id) and the adapters' RemoteBrowserSession: one
 * session at a time, frames fan out to subscribers, input events go to CDP, "save" runs the
 * adapter's capture() and stores the account.
 */
export class BrowserSessionService {
  private readonly sessions = new Map<string, Managed>();

  constructor(
    private readonly browser: BrowserManagerApi,
    private readonly accounts: AccountService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {}

  async start(network: Network): Promise<{ sessionId: string }> {
    const adapter = this.accounts.adapter(network);
    if (adapter.connect.kind !== 'browser')
      throw new PosterError('VALIDATION', `${network} does not use a browser login.`);
    for (const m of this.sessions.values()) {
      if (m.state !== 'closed' && m.state !== 'error' && m.state !== 'saved') {
        throw new PosterError(
          'CONFLICT',
          `A remote browser session is already open (${m.network}). Close it first.`,
        );
      }
    }
    const id = newId();
    const managed: Managed = {
      id,
      network,
      session: null,
      subscribers: new Set(),
      lastFrame: null,
      state: 'started',
      saving: false,
    };
    this.sessions.set(id, managed);
    const connect = adapter.connect;
    const account = this.accounts.getState(network);
    const profileDir = this.accounts.profileDirFor(network);
    mkdirSync(profileDir, { recursive: true });
    const idleMs = this.settings.get().browser.remoteSessionIdleMinutes * 60_000;
    try {
      managed.session = await this.browser.startRemoteSession({
        network,
        profileDir,
        proxy: account?.proxy ?? null,
        startUrl: connect.startUrl,
        allowedHosts: connect.allowedHosts,
        idleMs,
        onFrame: (f) => {
          const msg: BrowserServerMessage = { type: 'frame', ...f };
          managed.lastFrame = msg;
          this.broadcast(managed, msg);
        },
        onState: (state, message) => {
          if (managed.state === 'saved' && state === 'closed') return; // keep "saved" as the final state
          managed.state = state;
          this.broadcast(managed, { type: 'state', state, message });
          this.events.emit({ type: 'browser.session', sessionId: id, state, message });
        },
        onUrl: (url) => this.broadcast(managed, { type: 'url', url }),
        detectLoggedIn: (page) =>
          connect.detectLoggedIn(page as unknown as Parameters<typeof connect.detectLoggedIn>[0]),
      });
    } catch (err) {
      managed.state = 'error';
      this.sessions.delete(id);
      throw PosterError.from(err, 'INTERNAL');
    }
    this.events.emit({ type: 'browser.session', sessionId: id, state: 'started' });
    this.logger.info({ sessionId: id, network }, 'remote browser session started');
    return { sessionId: id };
  }

  get(id: string): Managed | undefined {
    return this.sessions.get(id);
  }

  subscribe(id: string, fn: (msg: BrowserServerMessage) => void): () => void {
    const m = this.sessions.get(id);
    if (!m) throw new PosterError('NOT_FOUND', 'Browser session not found or already closed.');
    m.subscribers.add(fn);
    fn({ type: 'state', state: m.state });
    if (m.lastFrame) fn(m.lastFrame);
    if (m.session) fn({ type: 'url', url: m.session.page.url() });
    return () => m.subscribers.delete(fn);
  }

  async handle(id: string, msg: BrowserClientMessage): Promise<void> {
    const m = this.sessions.get(id);
    if (!m?.session)
      throw new PosterError('NOT_FOUND', 'Browser session not found or already closed.');
    const s = m.session;
    s.touch();
    switch (msg.type) {
      case 'mouse': {
        const { type: _t, event, ...rest } = msg;
        await s.dispatchMouse({ type: event, ...rest });
        return;
      }
      case 'key': {
        const { type: _t, event, ...rest } = msg;
        await s.dispatchKey({ type: event, ...rest });
        return;
      }
      case 'text':
        await s.insertText(msg.text);
        return;
      case 'navigate':
        await s.navigate(msg.url);
        return;
      case 'save':
        await this.save(m);
        return;
      case 'close':
        await this.close(id, 'closed by user');
        return;
    }
  }

  private async save(m: Managed): Promise<void> {
    if (!m.session || m.saving) return;
    m.saving = true;
    const adapter = this.accounts.adapter(m.network);
    if (adapter.connect.kind !== 'browser') return;
    try {
      const capture = adapter.connect.capture;
      const result = await capture(
        m.session.page as unknown as Parameters<typeof capture>[0],
        this.accounts.adapterContext(m.network),
      );
      await this.accounts.saveConnection(m.network, result, 'ui');
      m.state = 'saved';
      this.broadcast(m, {
        type: 'state',
        state: 'saved',
        message: result.handle ? `Saved login for ${result.handle}` : 'Login saved',
      });
      this.events.emit({ type: 'browser.session', sessionId: m.id, state: 'saved' });
      await m.session.close('saved');
    } catch (err) {
      const pe = PosterError.from(err, 'INTERNAL');
      m.saving = false;
      this.broadcast(m, { type: 'state', state: 'error', message: `Save failed: ${pe.message}` });
      this.logger.warn({ err, network: m.network }, 'capture failed');
    }
  }

  async close(id: string, reason = 'closed'): Promise<void> {
    const m = this.sessions.get(id);
    if (!m) return;
    try {
      await m.session?.close(reason);
    } finally {
      if (m.state !== 'saved') m.state = 'closed';
      setTimeout(() => this.sessions.delete(id), 60_000).unref();
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id, 'shutdown');
  }

  private broadcast(m: Managed, msg: BrowserServerMessage): void {
    for (const fn of m.subscribers) {
      try {
        fn(msg);
      } catch (err) {
        this.logger.debug({ err }, 'browser subscriber failed');
      }
    }
  }
}
