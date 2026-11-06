import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PosterError } from '@poster/core';
import type { Services } from '../bootstrap.js';
import { mcpRoutes } from '../mcp/index.js';
import { MAX_MEDIA_BYTES } from '../services/media.js';
import { hostAllowed, makeAuthHooks } from './auth-hooks.js';
import { errorHandler, sendProblem } from './problem.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { mediaRoutes } from './routes/media.js';
import { postRoutes } from './routes/posts.js';
import { effectiveHosts, settingsRoutes } from './routes/settings.js';
import { wsRoutes } from './routes/ws.js';

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config, logger, vault } = services;
  const app = Fastify({
    loggerInstance: logger.child({ component: 'http' }),
    trustProxy: config.TRUST_PROXY === true ? '127.0.0.1' : false,
    bodyLimit: 2 * 1024 * 1024,
    forceCloseConnections: config.isTest ? true : 'idle',
  }) as unknown as FastifyInstance;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  await app.register(cookie, { secret: vault.hmac('cookie', 'signing-key') });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 5 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Host check (DNS rebinding) for everything but /health.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const allowed = effectiveHosts(services);
    if (!hostAllowed(request.headers.host, allowed)) {
      return sendProblem(
        reply,
        new PosterError('FORBIDDEN', `Host "${request.headers.host ?? ''}" is not allowed.`, {
          status: 421,
        }),
        request.url,
      );
    }
  });

  // Security headers for the UI.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  const hooks = makeAuthHooks(services);
  app.decorateRequest('principal', null);

  await app.register(
    async (api) => {
      await authRoutes(api, services, hooks);
      await accountRoutes(api, services, hooks);
      await postRoutes(api, services, hooks);
      await mediaRoutes(api, services, hooks);
      await settingsRoutes(api, services, hooks);
    },
    { prefix: '/api/v1' },
  );
  await wsRoutes(app, services, hooks);
  await healthRoutes(app, services, hooks);
  await mcpRoutes(app, services, hooks);

  // Static UI with SPA fallback.
  const publicDir = config.publicDir;
  if (existsSync(join(publicDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
      cacheControl: true,
      maxAge: '1h',
      immutable: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/mcp') &&
        !request.url.startsWith('/ws/')
      ) {
        return reply.header('cache-control', 'no-store').sendFile('index.html');
      }
      return sendProblem(reply, new PosterError('NOT_FOUND', 'Route not found'), request.url);
    });
  } else {
    logger.warn(
      { publicDir },
      'UI build not found; serving API only (run pnpm --filter @poster/web build)',
    );
    app.setNotFoundHandler(async (request, reply) =>
      sendProblem(reply, new PosterError('NOT_FOUND', 'Route not found'), request.url),
    );
  }

  return app;
}
