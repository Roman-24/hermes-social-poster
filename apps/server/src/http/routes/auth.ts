import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PosterError } from '@poster/core';
import type { Services } from '../../bootstrap.js';
import { SESSION_COOKIE } from '../../services/auth.js';
import type { AuthHooks } from '../auth-hooks.js';

export async function authRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { auth, audit, config } = services;
  const secure = !config.isTest && config.NODE_ENV !== 'development';

  f.get('/auth/me', async (request) => {
    const s = hooks.uiSession(request);
    return {
      authenticated: !!s,
      setupRequired: auth.setupRequired(),
      totpEnabled: auth.totpEnabled(),
      csrfToken: s ? auth.csrfFor(s.id) : null,
    };
  });

  f.post(
    '/auth/setup',
    { schema: { body: z.object({ password: z.string().min(10).max(200) }) } },
    async (request) => {
      if (!auth.setupRequired())
        throw new PosterError(
          'STATE_INVALID',
          'A password is already set. Use the change-password form.',
        );
      await auth.setPassword(request.body.password);
      audit.record('ui', 'auth.password_set');
      return { ok: true };
    },
  );

  f.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          password: z.string().min(1).max(200),
          totp: z.string().max(12).optional(),
        }),
      },
    },
    async (request, reply) => {
      const ok = await auth.verifyPassword(request.body.password);
      if (!ok) {
        audit.record('ui', 'auth.login_failed', null, { reason: 'password', ip: request.ip });
        throw new PosterError('UNAUTHORIZED', 'Wrong password.');
      }
      const totp = auth.verifyTotpIfEnabled(request.body.totp);
      if (totp === 'required')
        throw new PosterError('UNAUTHORIZED', 'TOTP code required.', {
          extra: { totpRequired: true },
        });
      if (totp === 'wrong') {
        audit.record('ui', 'auth.login_failed', null, { reason: 'totp' });
        throw new PosterError('UNAUTHORIZED', 'Wrong TOTP code.', {
          extra: { totpRequired: true },
        });
      }
      const session = auth.createSession(request.headers['user-agent']);
      reply.setCookie(SESSION_COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'strict',
        expires: new Date(session.expiresAt),
        signed: true,
      });
      audit.record('ui', 'auth.login', null, { ip: request.ip });
      return { ok: true, csrfToken: session.csrfToken };
    },
  );

  f.post('/auth/logout', async (request, reply) => {
    const s = hooks.uiSession(request);
    if (s) auth.revokeSession(s.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  f.post('/auth/totp/setup', { preHandler: hooks.requireUi }, async () => auth.totpSetup());

  f.post(
    '/auth/totp/enable',
    { preHandler: hooks.requireUi, schema: { body: z.object({ code: z.string().min(6).max(8) }) } },
    async (request) => {
      auth.totpEnable(request.body.code);
      return { ok: true };
    },
  );

  f.delete(
    '/auth/totp',
    { preHandler: hooks.requireUi, schema: { body: z.object({ code: z.string().min(6).max(8) }) } },
    async (request) => {
      auth.totpDisable(request.body.code);
      return { ok: true };
    },
  );

  f.post(
    '/auth/password',
    {
      preHandler: hooks.requireUi,
      schema: { body: z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }) },
    },
    async (request, reply) => {
      await auth.changePassword(request.body.current, request.body.next);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
}
