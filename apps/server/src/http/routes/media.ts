import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PosterError, UploadMediaInputSchema } from '@poster/core';
import type { Services } from '../../bootstrap.js';
import type { AuthHooks } from '../auth-hooks.js';

export async function mediaRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const { media } = services;
  const Id = z.object({ id: z.string() });

  f.post('/media', { preHandler: hooks.requireUiOrApi('write') }, async (request) => {
    if (!request.isMultipart())
      throw new PosterError('VALIDATION', 'Expected multipart/form-data with a "file" part.');
    let altText: string | undefined;
    let fileBuf: Buffer | null = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (fileBuf) {
          await part.toBuffer(); // drain
          continue;
        }
        fileBuf = await part.toBuffer();
      } else if (part.fieldname === 'altText' && typeof part.value === 'string') {
        altText = part.value;
      }
    }
    if (!fileBuf || fileBuf.length === 0) throw new PosterError('VALIDATION', 'No file uploaded.');
    return media.ingestBuffer(fileBuf, { altText });
  });

  f.post(
    '/media/from-path',
    { preHandler: hooks.requireUiOrApi('write'), schema: { body: UploadMediaInputSchema } },
    async (request) => media.ingestFromInbox(request.body.path, request.body.altText),
  );

  f.get(
    '/media/:id',
    { preHandler: hooks.requireUiOrApi('read'), schema: { params: Id } },
    async (request) => {
      const info = media.get(request.params.id);
      return { ...info, compatibility: media.compatibility(info) };
    },
  );

  f.get(
    '/media/:id/preview',
    { preHandler: hooks.requireUi, schema: { params: Id } },
    async (request, reply) => {
      const buf = await media.thumbnail(request.params.id);
      return reply.type('image/jpeg').header('cache-control', 'private, max-age=3600').send(buf);
    },
  );
}
