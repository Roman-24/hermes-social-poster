import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../bootstrap.js';
import type { AuthHooks } from '../auth-hooks.js';

const VERSION = '0.1.0';

export async function settingsRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { settings, auth, notifier, audit, scheduler, posts, startedAt, config, jobs } = services;

  const view = () => {
    const s = settings.get();
    return {
      ...s,
      secretsSet: {
        hermesWebhookSecret: settings.hasSecret('hermes.webhookSecret'),
        linkedinClientSecret: settings.hasSecret('linkedin.clientSecret'),
        mcpToken: auth.hasToken('mcp') || !!config.POSTER_MCP_TOKEN,
        apiToken: auth.hasToken('api'),
      },
      linkedinClientId: settings.getSecret('linkedin.clientId'),
      effectiveLimits: settings.limits(),
      allowedHostsEffective: [...effectiveHosts(services)],
    };
  };

  f.get('/settings', { preHandler: hooks.requireUi }, async () => view());

  f.put(
    '/settings',
    {
      preHandler: hooks.requireUi,
      // Loose body: the merged document is validated in SettingsService.update (see note there).
      schema: {
        body: z
          .object({
            secrets: z
              .object({
                hermesWebhookSecret: z.string().optional(),
                linkedinClientSecret: z.string().optional(),
                linkedinClientId: z.string().optional(),
              })
              .optional(),
          })
          .catchall(z.unknown()),
      },
    },
    async (request) => {
      const {
        secrets,
        secretsSet: _a,
        effectiveLimits: _b,
        allowedHostsEffective: _c,
        linkedinClientId: _d,
        ...patch
      } = request.body as Record<string, unknown> & {
        secrets?: {
          hermesWebhookSecret?: string;
          linkedinClientSecret?: string;
          linkedinClientId?: string;
        };
      };
      settings.update(patch);
      if (secrets?.hermesWebhookSecret !== undefined)
        settings.setSecret('hermes.webhookSecret', secrets.hermesWebhookSecret);
      if (secrets?.linkedinClientSecret !== undefined)
        settings.setSecret('linkedin.clientSecret', secrets.linkedinClientSecret);
      if (secrets?.linkedinClientId !== undefined)
        settings.setSecret('linkedin.clientId', secrets.linkedinClientId);
      audit.record('ui', 'settings.update', null, {
        keys: Object.keys(patch),
        secrets: Object.keys(secrets ?? {}),
      });
      return view();
    },
  );

  f.post(
    '/settings/tokens/:kind/rotate',
    {
      preHandler: hooks.requireUi,
      schema: {
        params: z.object({ kind: z.enum(['mcp', 'api']) }),
        body: z
          .object({
            scope: z.enum(['read', 'write']).optional(),
            label: z.string().max(60).optional(),
          })
          .optional(),
      },
    },
    async (request) => {
      const token = auth.rotateToken(
        request.params.kind,
        request.params.kind === 'mcp' ? 'write' : (request.body?.scope ?? 'write'),
        request.body?.label,
      );
      return { token };
    },
  );

  f.post('/settings/webhook/test', { preHandler: hooks.requireUi }, async () =>
    notifier.testPing(),
  );

  f.get(
    '/notifications',
    {
      preHandler: hooks.requireUi,
      schema: {
        querystring: z.object({
          undelivered: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (request) =>
      notifier.list({
        undeliveredOnly: request.query.undelivered === '1' || request.query.undelivered === 'true',
        limit: request.query.limit,
      }),
  );

  f.post(
    '/notifications/:id/retry',
    { preHandler: hooks.requireUi, schema: { params: z.object({ id: z.string() }) } },
    async (request) => notifier.retry(request.params.id),
  );

  f.get('/system', { preHandler: hooks.requireUiOrApi('read') }, async () => ({
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
    now: new Date().toISOString(),
    tz: settings.get().defaultTz,
    codeDelivery: notifier.codeDeliveryMode(),
    fakeAdapters: config.fakeAdapters,
    scheduler: {
      lastTickAt: scheduler.lastTickAt,
      lagMs: scheduler.lagMs,
      running: scheduler.running,
    },
    counts: posts.counts(),
    openTargets: jobs.openTargets(),
  }));

  f.get(
    '/audit',
    {
      preHandler: hooks.requireUi,
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: z.string().optional(),
        }),
      },
    },
    async (request) => audit.list(request.query.limit, request.query.cursor),
  );

  f.post('/system/self-test', { preHandler: hooks.requireUi }, async () => jobs.runSelfTests());
  f.post('/system/retention', { preHandler: hooks.requireUi }, async () => jobs.runRetention());
}

export function effectiveHosts(services: Services): Set<string> {
  const { config, settings } = services;
  const port = config.PORT;
  const set = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    '127.0.0.1',
    'localhost',
    '[::1]',
  ]);
  for (const h of [...config.allowedHostsEnv, ...settings.get().allowedHosts]) {
    const v = h.trim().toLowerCase();
    if (v) set.add(v);
  }
  if (config.POSTER_PUBLIC_URL) {
    try {
      set.add(new URL(config.POSTER_PUBLIC_URL).host.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return set;
}
