import type { FastifyReply, FastifyRequest } from 'fastify';
import { PosterError } from '@poster/core';
import type { Services } from '../bootstrap.js';
import { SESSION_COOKIE, type Principal, type TokenScope } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function makeAuthHooks(services: Services) {
  const { auth } = services;

  /** Resolve the UI session from the cookie (no CSRF check here). */
  function uiSession(request: FastifyRequest): { id: string } | null {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    const value = unsigned.valid ? unsigned.value : raw;
    return auth.validateSession(value ?? undefined);
  }

  function requireCsrf(request: FastifyRequest, sessionId: string): void {
    if (!MUTATING.has(request.method)) return;
    const token = request.headers['x-csrf-token'];
    if (!auth.verifyCsrf(sessionId, typeof token === 'string' ? token : undefined)) {
      throw new PosterError('FORBIDDEN', 'Missing or invalid CSRF token.');
    }
  }

  /** UI session only (settings, accounts, tokens…). */
  async function requireUi(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const s = uiSession(request);
    if (!s) throw new PosterError('UNAUTHORIZED', 'Login required.');
    requireCsrf(request, s.id);
    request.principal = { kind: 'ui', scope: 'write', sessionId: s.id };
  }

  /** UI session or API bearer token (posts, drafts, media, read-only system info). */
  function requireUiOrApi(minScope: TokenScope = 'read') {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const s = uiSession(request);
      if (s) {
        requireCsrf(request, s.id);
        request.principal = { kind: 'ui', scope: 'write', sessionId: s.id };
        return;
      }
      const p = auth.authenticateBearer(request.headers.authorization, 'api');
      if (!p) throw new PosterError('UNAUTHORIZED', 'Login or API token required.');
      if (minScope === 'write' && p.scope !== 'write')
        throw new PosterError('FORBIDDEN', 'This API token is read-only.');
      request.principal = p;
    };
  }

  /** Hermes: MCP bearer token. */
  async function requireMcp(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const p = auth.authenticateBearer(request.headers.authorization, 'mcp');
    if (!p) throw new PosterError('UNAUTHORIZED', 'Invalid or missing MCP bearer token.');
    request.principal = p;
  }

  return { uiSession, requireUi, requireUiOrApi, requireMcp };
}

export type AuthHooks = ReturnType<typeof makeAuthHooks>;

/** Host-header allowlist (DNS rebinding protection). */
export function hostAllowed(host: string | undefined, allowed: Set<string>): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (allowed.has(h)) return true;
  const bare = h.replace(/:\d+$/, '');
  return allowed.has(bare);
}
