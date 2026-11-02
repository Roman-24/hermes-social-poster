import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId, NetworkSchema, PosterError, type Network } from '@poster/core';
import type { Services } from '../../bootstrap.js';
import { oauthStates } from '../../db/schema.js';
import type { AuthHooks } from '../auth-hooks.js';

export async function accountRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { accounts, browserSessions, settings, db, audit, config, jobs } = services;
  const Params = z.object({ network: NetworkSchema });

  f.get('/accounts', { preHandler: hooks.requireUiOrApi('read') }, async () =>
    accounts.listViews(false),
  );

  f.get(
    '/accounts/:network',
    { preHandler: hooks.requireUiOrApi('read'), schema: { params: Params } },
    async (request) => accounts.view(request.params.network, true),
  );

  f.post(
    '/accounts/:network/connect',
    {
      preHandler: hooks.requireUi,
      schema: {
        params: Params,
        body: z.object({ fields: z.record(z.string(), z.string()).optional() }).optional(),
      },
    },
    async (request, reply) => {
      const network = request.params.network;
      const adapter = accounts.adapter(network);
      const ctx = accounts.adapterContext(network);
      switch (adapter.connect.kind) {
        case 'credentials': {
          const fields = request.body?.fields ?? {};
          for (const fdef of adapter.connect.fields) {
            if (!fields[fdef.name])
              throw new PosterError('VALIDATION', `Field "${fdef.label}" is required.`);
          }
          const result = await adapter.connect.connect(fields, ctx);
          return accounts.saveConnection(network, result, 'ui');
        }
        case 'oauth': {
          const clientId = settings.getSecret('linkedin.clientId');
          if (!clientId)
            throw new PosterError(
              'STATE_INVALID',
              'Add the LinkedIn app client id and secret in Settings first.',
            );
          const redirectUri = `${publicBase(request.headers.host, config.POSTER_PUBLIC_URL)}/api/v1/accounts/${network}/callback`;
          const verifier = randomBytes(48).toString('base64url');
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          const state = newId();
          db.delete(oauthStates).where(lt(oauthStates.expiresAt, Date.now())).run();
          db.insert(oauthStates)
            .values({
              state,
              network,
              codeVerifier: verifier,
              redirectUri,
              createdAt: Date.now(),
              expiresAt: Date.now() + 15 * 60_000,
            })
            .run();
          const url = adapter.connect.authorizeUrl({
            redirectUri,
            state,
            codeChallenge: challenge,
            clientId,
          });
          return reply.send({ kind: 'oauth', url });
        }
        case 'browser': {
          const { sessionId } = await browserSessions.start(network);
          return reply.send({ kind: 'browser', sessionId });
        }
      }
    },
  );

  f.get(
    '/accounts/:network/callback',
    {
      schema: {
        params: Params,
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const network = request.params.network;
      const q = request.query;
      const fail = (msg: string) => reply.redirect(`/accounts?error=${encodeURIComponent(msg)}`);
      if (q.error) return fail(q.error_description ?? q.error);
      if (!q.code || !q.state) return fail('Missing code or state in the OAuth callback.');
      const row = db
        .select()
        .from(oauthStates)
        .where(and(eq(oauthStates.state, q.state), eq(oauthStates.network, network)))
        .get();
      db.delete(oauthStates).where(eq(oauthStates.state, q.state)).run();
      if (!row || row.expiresAt < Date.now())
        return fail('OAuth state expired or unknown. Start the connection again.');
      const adapter = accounts.adapter(network);
      if (adapter.connect.kind !== 'oauth') return fail('Network does not use OAuth.');
      const clientId = settings.getSecret('linkedin.clientId');
      const clientSecret = settings.getSecret('linkedin.clientSecret');
      if (!clientId || !clientSecret)
        return fail('LinkedIn client credentials are missing in Settings.');
      try {
        const result = await adapter.connect.exchangeCode(
          {
            code: q.code,
            redirectUri: row.redirectUri,
            codeVerifier: row.codeVerifier,
            clientId,
            clientSecret,
          },
          accounts.adapterContext(network),
        );
        await accounts.saveConnection(network, result, 'ui');
        return reply.redirect(`/accounts?connected=${network}`);
      } catch (err) {
        request.log.warn({ err, network }, 'oauth exchange failed');
        return fail(err instanceof Error ? err.message : 'OAuth exchange failed');
      }
    },
  );

  f.delete(
    '/accounts/:network',
    { preHandler: hooks.requireUi, schema: { params: Params } },
    async (request) => accounts.disconnect(request.params.network, 'ui'),
  );

  f.post(
    '/accounts/:network/test-post',
    { preHandler: hooks.requireUi, schema: { params: Params } },
    async (request) => {
      const network = request.params.network as Network;
      const adapter = accounts.adapter(network);
      const state = accounts.getState(network);
      if (!adapter.testPost) throw new PosterError('STATE_INVALID', `${network} has no test post.`);
      if (!state?.secrets) throw new PosterError('NOT_CONNECTED', `${network} is not connected.`);
      const attemptKey = `test-${newId()}`;
      const result = await adapter.testPost(state, {
        ...accounts.adapterContext(network, attemptKey),
        attemptKey,
        account: state,
        updateAccount: (patch) => accounts.patch(network, patch),
      });
      audit.record('ui', 'account.test_post', network, { url: result.url });
      return { url: result.url ?? null, remoteIds: result.remoteIds };
    },
  );

  f.post(
    '/accounts/:network/self-test',
    { preHandler: hooks.requireUi, schema: { params: Params } },
    async (request) => {
      const network = request.params.network;
      const out = await jobs.runSelfTests([network]);
      return (
        out[network] ?? {
          ok: false,
          message: 'No self-test available (not connected or unsupported).',
        }
      );
    },
  );

  f.put(
    '/accounts/:network/proxy',
    {
      preHandler: hooks.requireUi,
      schema: { params: Params, body: z.object({ proxy: z.string().url().nullable() }) },
    },
    async (request) => {
      accounts.setProxy(request.params.network, request.body.proxy);
      audit.record('ui', 'account.proxy', request.params.network, { set: !!request.body.proxy });
      return accounts.view(request.params.network);
    },
  );

  f.delete(
    '/browser-sessions/:id',
    { preHandler: hooks.requireUi, schema: { params: z.object({ id: z.string() }) } },
    async (request) => {
      await browserSessions.close(request.params.id, 'closed by user');
      return { ok: true };
    },
  );
}

function publicBase(host: string | undefined, configured: string | undefined): string {
  if (configured) return configured.replace(/\/+$/, '');
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])/.test(host)) return `https://${host}`;
  return `http://${host ?? '127.0.0.1:8787'}`;
}
