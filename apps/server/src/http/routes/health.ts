import type { FastifyInstance } from 'fastify';
import { PosterError } from '@poster/core';
import type { Services } from '../../bootstrap.js';
import type { AuthHooks } from '../auth-hooks.js';

export async function healthRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  // Liveness: no auth, minimal output, exempt from the Host check.
  app.get('/health', async () => ({ ok: true }));

  app.get('/metrics', async (request, reply) => {
    const s = hooks.uiSession(request);
    const api = s ? null : services.auth.authenticateBearer(request.headers.authorization, 'api');
    if (!s && !api) throw new PosterError('UNAUTHORIZED', 'Login or API token required.');
    const counts = services.posts.counts();
    const text = services.metrics.render({
      poster_posts_scheduled: counts.scheduled,
      poster_posts_publishing: counts.publishing,
      poster_posts_failed_24h: counts.failed24h,
      poster_uptime_seconds: Math.round((Date.now() - services.startedAt) / 1000),
      poster_undelivered_notifications: services.notifier.list({
        undeliveredOnly: true,
        limit: 500,
      }).length,
    });
    return reply.type('text/plain; version=0.0.4').send(text);
  });
}
