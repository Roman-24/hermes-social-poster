import { ApiErrors } from 'rettiwt-api';
import { PosterError, isTransientNetworkError } from '@poster/core';

/**
 * Map rettiwt-api / axios / X API failures onto our stable codes.
 *  - 401/403 or rettiwt's authentication messages → AUTH_REQUIRED (you log in again via the UI)
 *  - 429 → RATE_LIMITED (retryable)
 *  - 5xx / socket errors → UPSTREAM_ERROR / NETWORK_ERROR (retryable)
 *  - anything else → UPSTREAM_ERROR, non-retryable, so the composer fallback can decide
 */
export function mapXError(err: unknown): PosterError {
  if (PosterError.is(err)) return err as PosterError;
  const e = err as {
    message?: string;
    status?: number;
    response?: { status?: number };
    code?: string;
    details?: unknown[];
  };
  const status = e?.status ?? e?.response?.status;
  const message = e?.message ?? String(err);

  const authMessages = [
    ApiErrors.COULD_NOT_AUTHENTICATE,
    ApiErrors.BAD_AUTHENTICATION,
    ApiErrors.RESOURCE_NOT_ALLOWED,
  ];
  if (
    status === 401 ||
    status === 403 ||
    authMessages.some((m) => message.includes(m)) ||
    /not logged in|authenticat/i.test(message)
  ) {
    return new PosterError(
      'AUTH_REQUIRED',
      `X session rejected: ${message}. Log in again in Accounts → X.`,
      { cause: err },
    );
  }
  if (status === 429 || /rate limit|too many requests/i.test(message)) {
    return new PosterError('RATE_LIMITED', `X rate limit: ${message}`, { cause: err });
  }
  if (status !== undefined && status >= 500) {
    return new PosterError('UPSTREAM_ERROR', `X server error ${status}: ${message}`, {
      cause: err,
      retryable: true,
    });
  }
  if (
    isTransientNetworkError(err) ||
    (e?.code && /ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(e.code))
  ) {
    return new PosterError('NETWORK_ERROR', `Network error talking to X: ${message}`, {
      cause: err,
    });
  }
  return new PosterError('UPSTREAM_ERROR', `X API error: ${message}`, {
    cause: err,
    retryable: false,
  });
}
