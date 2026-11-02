import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PosterError } from '@poster/core';
import type { Services } from '../../bootstrap.js';
import type { BrowserClientMessage } from '../../services/browser-sessions.js';
import type { AuthHooks } from '../auth-hooks.js';

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
  const { events, browserSessions, logger } = services;

  // Cookie auth for both sockets (no CSRF: WebSocket upgrades are GETs and SameSite=Strict applies).
  const requireUiSocket = async (request: Parameters<typeof hooks.uiSession>[0]) => {
    if (!hooks.uiSession(request)) throw new PosterError('UNAUTHORIZED', 'Login required.');
  };

  app.get('/ws/events', { websocket: true, preValidation: requireUiSocket }, (socket) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
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
      const send = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      let off: (() => void) | null = null;
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
