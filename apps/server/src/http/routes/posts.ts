import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CancelPostInputSchema,
  CreateDraftInputSchema,
  ListPostsInputSchema,
  NetworkSchema,
  PosterError,
  PostStatusSchema,
  ScheduleInputSchema,
  UpdateDraftInputSchema,
} from '@poster/core';
import type { Services } from '../../bootstrap.js';
import { attempts, postTargets } from '../../db/schema.js';
import type { AuthHooks } from '../auth-hooks.js';

export async function postRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { posts, db } = services;
  const Id = z.object({ id: z.string() });
  const actorOf = (p: { kind: 'ui' | 'mcp' | 'api' } | null) =>
    (p?.kind === 'ui' ? 'ui' : p?.kind === 'mcp' ? 'mcp' : 'api') as 'ui' | 'mcp' | 'api';

  f.post(
    '/drafts',
    { preHandler: hooks.requireUiOrApi('write'), schema: { body: CreateDraftInputSchema } },
    async (request) => posts.createDraft(request.body, actorOf(request.principal)),
  );

  f.patch(
    '/drafts/:id',
    {
      preHandler: hooks.requireUiOrApi('write'),
      schema: { params: Id, body: UpdateDraftInputSchema.omit({ draftId: true }) },
    },
    async (request) =>
      posts.updateDraft(
        { ...request.body, draftId: request.params.id },
        actorOf(request.principal),
      ),
  );

  f.get(
    '/drafts/:id',
    { preHandler: hooks.requireUiOrApi('read'), schema: { params: Id } },
    async (request) => posts.preview(request.params.id),
  );

  f.post(
    '/drafts/:id/confirm',
    {
      preHandler: hooks.requireUiOrApi('write'),
      schema: { params: Id, body: z.object({ code: z.string().optional() }).optional() },
    },
    async (request) => {
      const trusted = request.principal?.kind === 'ui';
      return posts.confirm(request.params.id, {
        trusted,
        code: request.body?.code,
        actor: actorOf(request.principal),
      });
    },
  );

  f.get(
    '/posts',
    {
      preHandler: hooks.requireUiOrApi('read'),
      schema: {
        querystring: z.object({
          status: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
      },
    },
    async (request) => {
      const q = request.query;
      const statuses = q.status
        ? q.status
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => PostStatusSchema.parse(s))
        : undefined;
      return posts.list(
        ListPostsInputSchema.parse({
          status: statuses,
          from: q.from,
          to: q.to,
          limit: q.limit,
          cursor: q.cursor,
        }),
      );
    },
  );

  f.get(
    '/posts/:id',
    { preHandler: hooks.requireUiOrApi('read'), schema: { params: Id } },
    async (request) => posts.get(request.params.id, true),
  );

  f.post(
    '/posts/:id/cancel',
    {
      preHandler: hooks.requireUiOrApi('write'),
      schema: {
        params: Id,
        body: z.object({ networks: z.array(NetworkSchema).optional() }).optional(),
      },
    },
    async (request) =>
      posts.cancel(
        CancelPostInputSchema.parse({
          postId: request.params.id,
          networks: request.body?.networks,
        }),
        actorOf(request.principal),
      ),
  );

  f.post(
    '/posts/:id/retry',
    {
      preHandler: hooks.requireUiOrApi('write'),
      schema: {
        params: Id,
        body: z.object({ networks: z.array(NetworkSchema).optional() }).optional(),
      },
    },
    async (request) =>
      posts.retry(request.params.id, request.body?.networks, actorOf(request.principal)),
  );

  f.post(
    '/posts/:id/post-now',
    {
      preHandler: hooks.requireUiOrApi('write'),
      schema: {
        params: Id,
        body: z.object({ networks: z.array(NetworkSchema).optional() }).optional(),
      },
    },
    async (request) =>
      posts.postNow(request.params.id, request.body?.networks, actorOf(request.principal)),
  );

  f.post(
    '/posts/:id/reschedule',
    {
      preHandler: hooks.requireUiOrApi('write'),
      schema: {
        params: Id,
        body: z.object({
          schedule: ScheduleInputSchema,
          networks: z.array(NetworkSchema).optional(),
        }),
      },
    },
    async (request) => {
      if (request.principal?.kind !== 'ui')
        throw new PosterError(
          'FORBIDDEN',
          'Rescheduling via the API requires a UI session; use MCP reschedule_post for a confirmed flow.',
        );
      return posts.reschedule(
        request.params.id,
        request.body.schedule,
        request.body.networks,
        'ui',
        true,
      );
    },
  );

  f.get(
    '/posts/:id/attempts/:attemptId/screenshot',
    {
      preHandler: hooks.requireUi,
      schema: { params: z.object({ id: z.string(), attemptId: z.string() }) },
    },
    async (request, reply) => {
      const a = db.select().from(attempts).where(eq(attempts.id, request.params.attemptId)).get();
      if (!a) throw new PosterError('NOT_FOUND', 'Attempt not found');
      const t = db
        .select({ postId: postTargets.postId })
        .from(postTargets)
        .where(eq(postTargets.id, a.targetId))
        .get();
      if (t?.postId !== request.params.id) throw new PosterError('NOT_FOUND', 'Attempt not found');
      const path = a.debug.screenshot;
      if (
        typeof path !== 'string' ||
        !path.startsWith(services.config.debugDir) ||
        !existsSync(path)
      ) {
        throw new PosterError(
          'NOT_FOUND',
          'No screenshot for this attempt (deleted by retention or never taken).',
        );
      }
      return reply.type('image/png').send(await readFile(path));
    },
  );
}
