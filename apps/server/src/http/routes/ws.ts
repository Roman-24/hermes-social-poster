import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PosterError } from '@poster/core';
import type { Services } from '../../bootstrap.js';
import type { BrowserClientMessage } from '../../services/browser-sessions.js';
import type { AuthHooks } from '../auth-hooks.js';

/** How often an open socket re-checks that its session still exists. */
const SESSION_RECHECK_MS = 5_000;

function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // "null" and other opaque origins
  }
}

const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    event: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    clickCount: z.number().int().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    modifiers: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('key'),
    event: z.enum(['keyDown', 'keyUp', 'char']),
    key: z.string().optional(),
    code: z.string().optional(),
    text: z.string().optional(),
    modifiers: z.number().int().optional(),
    windowsVirtualKeyCode: z.number().int().optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string().max(10_000) }),
  z.object({ type: z.literal('navigate'), url: z.string().url() }),
  z.object({ type: z.literal('save') }),
  z.object({ type: z.literal('close') }),
]);

export async function wsRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const { events, browserSessions, logger, auth } = services;

  /**
   * Cookie auth for both sockets. A WebSocket upgrade is a GET, so the CSRF token that protects
   * the REST mutations does not apply, and SameSite=Strict only separates sites, not origins on
   * the same site. A browser always sends Origin on an upgrade, so require it to be this host;
   * clients that are not browsers send none and are authenticated by the cookie alone.
   */
  const requireUiSocket = async (request: Parameters<typeof hooks.uiSession>[0]) => {
    if (!hooks.uiSession(request)) throw new PosterError('UNAUTHORIZED', 'Login required.');
    const origin = request.headers.origin;
    if (origin !== undefined && !originMatchesHost(origin, request.headers.host)) {
      throw new PosterError('FORBIDDEN', 'Cross-origin WebSocket connections are not allowed.');
    }
  };

  /**
   * The cookie is checked once, at the upgrade, so tie the socket to that session and look again:
   * on a timer and before each client message. Logout, a password change, the CLI's set-password
   * (another process) and the 12 h expiry all delete the session row; none of them can reach a
   * socket, so the socket has to notice. Returns a function that is true while the session lives.
   */
  const bindToSession = (
    socket: {
      close(code?: number, reason?: string): void;
      on(ev: 'close' | 'error', cb: () => void): unknown;
    },
    request: Parameters<typeof hooks.uiSession>[0],
    onEnd: () => void,
  ): (() => boolean) => {
    const session = hooks.uiSession(request);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(guard);
      onEnd();
      socket.close(4401, 'session ended');
    };
    const alive = (): boolean => {
      if (ended) return false;
      if (session && auth.validateSession(session.id)) return true;
      end();
      return false;
    };
    const guard = setInterval(alive, SESSION_RECHECK_MS);
    guard.unref();
    socket.on('close', () => clearInterval(guard));
    socket.on('error', () => clearInterval(guard));
    return alive;
  };

  app.get('/ws/events', { websocket: true, preValidation: requireUiSocket }, (socket, request) => {
    const alive = bindToSession(socket, request, () => {
      off();
      clearInterval(ping);
    });
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN && alive()) socket.send(JSON.stringify(msg));
    };
    const off = events.on((ev) => send(ev));
    const ping = setInterval(() => send({ type: 'ping' }), 25_000);
    socket.on('close', () => {
      off();
      clearInterval(ping);
    });
    socket.on('error', () => {
      off();
      clearInterval(ping);
    });
  });

  app.get<{ Params: { id: string } }>(
    '/ws/browser/:id',
    { websocket: true, preValidation: requireUiSocket },
    (socket, request) => {
      const id = request.params.id;
      let off: (() => void) | null = null;
      const alive = bindToSession(socket, request, () => off?.());
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN && alive()) socket.send(JSON.stringify(msg));
      };
      try {
        off = browserSessions.subscribe(id, send);
      } catch (err) {
        send({
          type: 'state',
          state: 'error',
          message: err instanceof Error ? err.message : 'session not found',
        });
        socket.close(4404, 'session not found');
        return;
      }
      socket.on('message', (raw) => {
        if (!alive()) return; // revoked or expired: the socket is closed and the message dropped
        let msg: BrowserClientMessage;
        try {
          msg = ClientMessage.parse(JSON.parse(raw.toString())) as BrowserClientMessage;
        } catch {
          send({ type: 'state', state: 'error', message: 'invalid message' });
          return;
        }
        browserSessions.handle(id, msg).catch((err) => {
          logger.debug({ err, id }, 'browser input failed');
          send({
            type: 'state',
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        });
      });
      socket.on('close', () => off?.());
      socket.on('error', () => off?.());
    },
  );
}
