import { PosterError, isTransientNetworkError, type ErrorCode } from '@poster/core';

/**
 * Small fetch wrapper shared by the REST-style adapters (LinkedIn, Blossom, Bluesky video).
 * - Adds a timeout via AbortController that covers the whole exchange, response body included:
 *   the abort signal stays armed after the headers arrive, and fetch ties the body stream to it.
 * - Caps every buffered response body (MAX_BODY_BYTES; error bodies are capped lower).
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
/** Largest response body an adapter call buffers: descriptors, tokens and API replies are tiny. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Error bodies are quoted at 500 characters at most, so never read more than this. */
const ERROR_BODY_BYTES = 16 * 1024;

export async function fetchWithTimeout(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = opts;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request to ${safeUrl(url)} timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  timer.unref();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  let settled = false;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    settled = true;
    // Deliberately keep the timer and the caller's abort wired to the controller. fetch ties the
    // response body stream to this signal, so the timeout and the caller's signal now bound the
    // body read too; a server that sends headers and then trickles bytes cannot hold us forever.
    // An abort after the body was fully read is a no-op.
    return res;
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
    if (!settled) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
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

/** Throws a mapped PosterError when the response is not 2xx. Reads at most ERROR_BODY_BYTES of the body. */
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

/** Reads at most `maxBytes` of the body and cancels the rest. Rejects if the stream errors or is aborted. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      if (room > 0) chunks.push(value.subarray(0, room));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Best-effort body for error messages: never throws and never reads more than `maxBytes`. */
export async function safeText(res: Response, maxBytes = ERROR_BODY_BYTES): Promise<string> {
  try {
    return (await readCapped(res, maxBytes)).text;
  } catch {
    return '';
  }
}

export async function readJson<T = unknown>(
  res: Response,
  service: string,
  maxBytes = MAX_BODY_BYTES,
): Promise<T> {
  let body: { text: string; truncated: boolean };
  try {
    body = await readCapped(res, maxBytes);
  } catch (err) {
    throw new PosterError(
      'NETWORK_ERROR',
      `${service} response body failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (body.truncated) {
    throw new PosterError(
      'UPSTREAM_ERROR',
      `${service} response is larger than ${maxBytes} bytes`,
      {
        retryable: false,
      },
    );
  }
  if (!body.text) return undefined as T;
  try {
    return JSON.parse(body.text) as T;
  } catch {
    throw new PosterError(
      'UPSTREAM_ERROR',
      `${service} returned a non-JSON body: ${truncate(body.text, 200)}`,
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
