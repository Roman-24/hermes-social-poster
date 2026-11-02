import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { PosterError, type ProblemDetails } from '@poster/core';

/** RFC 9457 problem+json responses with a stable `code`. */
export function sendProblem(
  reply: FastifyReply,
  err: PosterError,
  instance?: string,
): FastifyReply {
  const body: ProblemDetails = err.toProblem(instance);
  return reply.status(err.status).type('application/problem+json').send(body);
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (PosterError.is(error)) return sendProblem(reply, error as PosterError, request.url);

  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = error.validation
      .map((v) => `${v.instancePath || 'body'}: ${v.message}`)
      .join('; ');
    return sendProblem(
      reply,
      new PosterError('VALIDATION', details || 'Invalid request', {
        extra: { issues: error.validation },
      }),
      request.url,
    );
  }
  if (isResponseSerializationError(error)) {
    request.log.error({ err: error }, 'response serialization failed');
    return sendProblem(
      reply,
      new PosterError('INTERNAL', 'Response serialization failed'),
      request.url,
    );
  }

  const fe = error as FastifyError;
  if (fe.statusCode === 429)
    return sendProblem(
      reply,
      new PosterError('RATE_LIMITED', 'Too many requests. Try again in a minute.'),
      request.url,
    );
  if (fe.statusCode === 413)
    return sendProblem(
      reply,
      new PosterError('MEDIA_TOO_LARGE', 'Request body too large.'),
      request.url,
    );
  if (fe.statusCode === 415)
    return sendProblem(
      reply,
      new PosterError('MEDIA_UNSUPPORTED', 'Unsupported media type.'),
      request.url,
    );
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return sendProblem(
      reply,
      new PosterError('VALIDATION', fe.message, { status: fe.statusCode }),
      request.url,
    );
  }
  request.log.error({ err: error }, 'unhandled error');
  return sendProblem(reply, new PosterError('INTERNAL', 'Internal error'), request.url);
}
