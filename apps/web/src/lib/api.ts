import type {
  AccountView,
  CreateDraftInput,
  DraftPreview,
  MediaUploadResult,
  NotificationView,
  PostList,
  PostStatus,
  PostView,
  ScheduleInput,
  Settings,
  Network,
} from '@poster/core';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
    super(detail || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

export interface AuthMe {
  authenticated: boolean;
  setupRequired: boolean;
  totpEnabled: boolean;
  csrfToken: string;
}

export interface SettingsView extends Settings {
  secretsSet: {
    hermesWebhookSecret: boolean;
    linkedinClientSecret: boolean;
    mcpToken: boolean;
    apiToken: boolean;
  };
  linkedinClientId: string | null;
  effectiveLimits: Record<string, unknown>;
}

export interface SettingsUpdate extends Partial<Settings> {
  secrets?: {
    hermesWebhookSecret?: string;
    linkedinClientSecret?: string;
    linkedinClientId?: string;
  };
}

export interface SystemInfo {
  version: string;
  uptimeMs: number;
  now: number;
  tz: string;
  codeDelivery: 'direct' | 'returned' | 'none';
  scheduler: { lastTickAt: number | null; lagMs: number | null; running: boolean };
  counts: { scheduled: number; publishing: number; failed24h: number };
}

export interface ConnectResponse {
  kind?: 'oauth' | 'browser';
  url?: string;
  sessionId?: string;
}

const BASE = '/api/v1';
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

function isLoginPage(): boolean {
  return window.location.pathname.startsWith('/login');
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const code =
    (body?.code as string | undefined) ?? (res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL');
  const detail =
    (body?.detail as string | undefined) ?? (body?.title as string | undefined) ?? res.statusText;
  const extra: Record<string, unknown> = {};
  if (body) {
    for (const [k, v] of Object.entries(body)) {
      if (!['type', 'title', 'status', 'detail', 'instance', 'code'].includes(k)) extra[k] = v;
    }
    if (body.extra && typeof body.extra === 'object')
      Object.assign(extra, body.extra as Record<string, unknown>);
  }
  return new ApiError(res.status, code, detail, extra);
}

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const me = await getMe();
  csrfToken = me.csrfToken;
  return csrfToken;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  raw?: boolean;
  skipAuthRedirect?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.formData) body = opts.formData;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRF-Token'] = await ensureCsrf();
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body, credentials: 'same-origin' });
  if (res.status === 401 && !opts.skipAuthRedirect && !isLoginPage()) {
    csrfToken = null;
    window.location.assign('/login');
  }
  if (!res.ok) throw await parseError(res);
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
};

/* ---------------- auth ---------------- */

export async function getMe(): Promise<AuthMe> {
  const res = await fetch(`${BASE}/auth/me`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw await parseError(res);
  const me = (await res.json()) as AuthMe;
  csrfToken = me.csrfToken;
  return me;
}

export async function login(
  password: string,
  totp?: string,
): Promise<{ ok: true; csrfToken: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(totp ? { password, totp } : { password }),
  });
  if (!res.ok) throw await parseError(res);
  const out = (await res.json()) as { ok: true; csrfToken: string };
  csrfToken = out.csrfToken;
  return out;
}

export async function setupPassword(password: string): Promise<void> {
  await request('/auth/setup', { method: 'POST', body: { password }, skipAuthRedirect: true });
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
  csrfToken = null;
}

export const authApi = {
  changePassword: (current: string, next: string) =>
    api.post<{ ok: true }>('/auth/password', { current, next }),
  totpSetup: () => api.post<{ secret: string; otpauthUrl: string }>('/auth/totp/setup'),
  totpEnable: (code: string) => api.post<{ ok: true }>('/auth/totp/enable', { code }),
  totpDisable: (code: string) => api.del<{ ok: true }>('/auth/totp', { code }),
};

/* ---------------- accounts ---------------- */

export const accountsApi = {
  list: () => api.get<AccountView[]>('/accounts'),
  get: (network: Network) => api.get<AccountView>(`/accounts/${network}`),
  connect: (network: Network, fields?: Record<string, string>) =>
    api.post<AccountView | ConnectResponse>(
      `/accounts/${network}/connect`,
      fields ? { fields } : {},
    ),
  disconnect: (network: Network) => api.del<AccountView>(`/accounts/${network}`),
  testPost: (network: Network) =>
    api.post<{ url: string | null; remoteIds: string[] }>(`/accounts/${network}/test-post`),
  selfTest: (network: Network) =>
    api.post<{ ok: boolean; message: string; details?: Record<string, unknown> }>(
      `/accounts/${network}/self-test`,
    ),
  closeBrowserSession: (id: string) => api.del<{ ok: true }>(`/browser-sessions/${id}`),
};

/* ---------------- posts ---------------- */

export const postsApi = {
  list: (params: {
    status?: PostStatus[];
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  }) => {
    const q = new URLSearchParams();
    if (params.status?.length) q.set('status', params.status.join(','));
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.cursor) q.set('cursor', params.cursor);
    const qs = q.toString();
    return api.get<PostList>(`/posts${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<PostView>(`/posts/${id}`),
  cancel: (id: string, networks?: Network[]) =>
    api.post<{
      postId: string;
      status: PostStatus;
      cancelled: Network[];
      notCancelled: { network: Network; reason: string }[];
    }>(`/posts/${id}/cancel`, networks?.length ? { networks } : {}),
  retry: (id: string, networks?: Network[]) =>
    api.post<PostView>(`/posts/${id}/retry`, networks?.length ? { networks } : {}),
  reschedule: (id: string, schedule: ScheduleInput, networks?: Network[]) =>
    api.post<PostView>(`/posts/${id}/reschedule`, {
      schedule,
      ...(networks?.length ? { networks } : {}),
    }),
  postNow: (id: string, networks?: Network[]) =>
    api.post<PostView>(`/posts/${id}/post-now`, networks?.length ? { networks } : {}),
  createDraft: (input: CreateDraftInput) => api.post<DraftPreview>('/drafts', input),
  confirmDraft: (id: string) =>
    api.post<{ postId: string; status: PostStatus }>(`/drafts/${id}/confirm`, {}),
  screenshotUrl: (postId: string, attemptId: string) =>
    `${BASE}/posts/${postId}/attempts/${attemptId}/screenshot`,
};

/* ---------------- media ---------------- */

export const mediaApi = {
  upload: (file: File, altText?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (altText) fd.append('altText', altText);
    return request<MediaUploadResult>('/media', { method: 'POST', formData: fd });
  },
  previewUrl: (id: string) => `${BASE}/media/${id}/preview`,
};

/* ---------------- settings / system ---------------- */

export const settingsApi = {
  get: () => api.get<SettingsView>('/settings'),
  update: (patch: SettingsUpdate) => api.put<SettingsView>('/settings', patch),
  rotateToken: (kind: 'mcp' | 'api', scope?: 'read' | 'write') =>
    api.post<{ token: string }>(`/settings/tokens/${kind}/rotate`, scope ? { scope } : {}),
  webhookTest: () =>
    api.post<{ ok: boolean; status?: number; error?: string }>('/settings/webhook/test'),
};

export const notificationsApi = {
  list: (undelivered = true, limit = 50) =>
    api.get<NotificationView[]>(`/notifications?undelivered=${undelivered ? 1 : 0}&limit=${limit}`),
  retry: (id: string) => api.post<NotificationView>(`/notifications/${id}/retry`),
};

export const systemApi = {
  get: () => api.get<SystemInfo>('/system'),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail ? `${err.detail} (${err.code})` : err.code;
  if (err instanceof Error) return err.message;
  return String(err);
}
