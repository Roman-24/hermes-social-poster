import { PosterError, isTransientNetworkError, type ErrorCode } from '@poster/core';

/**
 * Small fetch wrapper shared by the REST-style adapters (LinkedIn, Blossom, Bluesky video).
 * - Adds a timeout via AbortController.
 * - Maps transport failures to PosterError('NETWORK_ERROR') (retryable).
 * - `expectOk` maps HTTP status to stable PosterError codes:
 *     401/403 → AUTH_REQUIRED, 429 → RATE_LIMITED, 5xx → UPSTREAM_ERROR (retryable),
 *     other 4xx → UPSTREAM_ERROR (not retryable) with the response body as detail.
 * Never logs headers (they carry bearer tokens).
 */

export interface HttpOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = opts;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request to ${safeUrl(url)} timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new PosterError(
        'NETWORK_ERROR',
        controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : `Request to ${safeUrl(url)} aborted`,
        {
          cause: err,
        },
      );
    }
    if (isTransientNetworkError(err) || err instanceof TypeError) {
      throw new PosterError(
        'NETWORK_ERROR',
        `Network error calling ${safeUrl(url)}: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
        },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ExpectOkOptions {
  /** Service name used in error messages. */
  service: string;
  /** Override code for 4xx other than 401/403/429 (default UPSTREAM_ERROR, not retryable). */
  clientErrorCode?: ErrorCode;
  /** Treat 401/403 as this code instead of AUTH_REQUIRED. */
  authErrorCode?: ErrorCode;
}

/** Throws a mapped PosterError when the response is not 2xx. Consumes the body on error. */
export async function expectOk(res: Response, opts: ExpectOkOptions): Promise<Response> {
  if (res.ok) return res;
  const body = await safeText(res);
  const detail = body ? `: ${truncate(body, 500)}` : '';
  const base = `${opts.service} responded ${res.status}${detail}`;
  if (res.status === 401 || res.status === 403) {
    throw new PosterError(opts.authErrorCode ?? 'AUTH_REQUIRED', base, {
      extra: { httpStatus: res.status },
    });
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new PosterError('RATE_LIMITED', base, {
      extra: { httpStatus: 429, ...(retryAfter ? { retryAfter } : {}) },
    });
  }
  if (res.status >= 500) {
    throw new PosterError('UPSTREAM_ERROR', base, {
      retryable: true,
      extra: { httpStatus: res.status },
    });
  }
  throw new PosterError(opts.clientErrorCode ?? 'UPSTREAM_ERROR', base, {
    retryable: false,
    extra: { httpStatus: res.status },
  });
}

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export async function readJson<T = unknown>(res: Response, service: string): Promise<T> {
  const text = await safeText(res);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PosterError(
      'UPSTREAM_ERROR',
      `${service} returned a non-JSON body: ${truncate(text, 200)}`,
      { retryable: false },
    );
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Strip query strings before putting a URL into an error message (tokens sometimes live there). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PosterError('INTERNAL', 'aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new PosterError('INTERNAL', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
