/**
 * Stable error codes shared by REST (RFC 9457 problem+json), MCP tool results and the UI.
 */
export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'STATE_INVALID',
  'SCHEDULE_INVALID',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'MISSED_WINDOW',
  'UNKNOWN_OUTCOME',
  'MEDIA_UNSUPPORTED',
  'MEDIA_TOO_LARGE',
  'NETWORK_ERROR',
  'UPSTREAM_ERROR',
  'NOT_CONNECTED',
  'SELECTOR_BROKEN',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  STATE_INVALID: 409,
  SCHEDULE_INVALID: 400,
  CODE_INVALID: 403,
  CODE_EXPIRED: 410,
  AUTH_REQUIRED: 401,
  RATE_LIMITED: 429,
  MISSED_WINDOW: 409,
  UNKNOWN_OUTCOME: 502,
  MEDIA_UNSUPPORTED: 415,
  MEDIA_TOO_LARGE: 413,
  NETWORK_ERROR: 502,
  UPSTREAM_ERROR: 502,
  NOT_CONNECTED: 409,
  SELECTOR_BROKEN: 502,
  INTERNAL: 500,
};

/** Codes for which the scheduler may retry automatically. */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'UPSTREAM_ERROR',
]);

export interface PosterErrorOptions {
  status?: number;
  detail?: string;
  retryable?: boolean;
  /** Extra, non-secret, machine-readable fields (e.g. { network: 'x', field: 'text' }). */
  extra?: Record<string, unknown>;
  cause?: unknown;
}

export class PosterError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly extra: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: PosterErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PosterError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code];
    this.retryable = opts.retryable ?? RETRYABLE_CODES.has(code);
    this.extra = opts.extra ?? {};
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: `urn:poster:error:${this.code.toLowerCase()}`,
      title: this.code,
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(instance ? { instance } : {}),
      ...this.extra,
    };
  }

  static is(err: unknown): err is PosterError {
    return (
      err instanceof PosterError ||
      (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'PosterError')
    );
  }

  static from(err: unknown, fallback: ErrorCode = 'INTERNAL'): PosterError {
    if (PosterError.is(err)) return err as PosterError;
    const message = err instanceof Error ? err.message : String(err);
    return new PosterError(fallback, message, { cause: err });
  }
}

/** RFC 9457 problem details, with our stable `code`. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  [k: string]: unknown;
}

export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (
    code &&
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(code)
  ) {
    return true;
  }
  return /fetch failed|socket hang up|network/i.test(err.message);
}
