import argon2 from 'argon2';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { newId, PosterError } from '@poster/core';
import type { Db } from '../db/index.js';
import { tokens, uiSessions } from '../db/schema.js';
import type { Vault } from '../vault.js';
import type { AuditService } from './audit.js';
import type { SettingsService } from './settings.js';

export const SESSION_COOKIE = 'poster_session';
const SESSION_TTL_MS = 12 * 3600_000;
const ARGON = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export type TokenKind = 'mcp' | 'api';
export type TokenScope = 'read' | 'write';

export interface Principal {
  kind: 'ui' | 'mcp' | 'api';
  scope: TokenScope;
  sessionId?: string;
  tokenId?: string;
}

/**
 * UI password (argon2id) + optional TOTP + 12 h session cookie + CSRF token;
 * bearer tokens for MCP and REST (SHA-256 at rest, constant-time compare).
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly bootstrapMcpToken?: string,
  ) {}

  /* ---------------- password ---------------- */

  setupRequired(): boolean {
    return !this.settings.hasSecret('ui.passwordHash');
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < 10)
      throw new PosterError('VALIDATION', 'Password must be at least 10 characters.');
    const hash = await argon2.hash(password, ARGON);
    this.settings.setSecret('ui.passwordHash', hash);
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = this.settings.getSecret('ui.passwordHash');
    if (!hash) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  async changePassword(current: string, next: string): Promise<void> {
    if (!(await this.verifyPassword(current)))
      throw new PosterError('UNAUTHORIZED', 'Current password is wrong.');
    await this.setPassword(next);
    this.revokeAllSessions();
    this.audit.record('ui', 'auth.password_changed');
  }

  /* ---------------- TOTP ---------------- */

  totpEnabled(): boolean {
    return this.settings.hasSecret('ui.totpSecret');
  }

  totpSetup(): { secret: string; otpauthUrl: string } {
    // Enrolling replaces the second factor, so it needs the same proof as removing it. While a
    // factor is active the only way out is totpDisable, which requires a current code.
    if (this.totpEnabled())
      throw new PosterError(
        'STATE_INVALID',
        'TOTP is already enabled. Disable it with a current code before enrolling a new authenticator.',
      );
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Social Poster',
      label: 'poster',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    this.settings.setSecret('ui.totpPending', secret.base32);
    return { secret: secret.base32, otpauthUrl: totp.toString() };
  }

  totpEnable(code: string): void {
    if (this.totpEnabled()) throw new PosterError('STATE_INVALID', 'TOTP is already enabled.');
    const pending = this.settings.getSecret('ui.totpPending');
    if (!pending) throw new PosterError('STATE_INVALID', 'Run TOTP setup first.');
    if (!verifyTotp(pending, code)) throw new PosterError('UNAUTHORIZED', 'Wrong TOTP code.');
    this.settings.setSecret('ui.totpSecret', pending);
    this.settings.setSecret('ui.totpPending', null);
    this.audit.record('ui', 'auth.totp_enabled');
  }

  totpDisable(code: string): void {
    const secret = this.settings.getSecret('ui.totpSecret');
    if (!secret) return;
    if (!verifyTotp(secret, code)) throw new PosterError('UNAUTHORIZED', 'Wrong TOTP code.');
    this.settings.setSecret('ui.totpSecret', null);
    // A pending secret left over from an earlier setup must not be promotable later.
    this.settings.setSecret('ui.totpPending', null);
    this.audit.record('ui', 'auth.totp_disabled');
  }

  verifyTotpIfEnabled(code: string | undefined): 'ok' | 'required' | 'wrong' {
    const secret = this.settings.getSecret('ui.totpSecret');
    if (!secret) return 'ok';
    if (!code) return 'required';
    return verifyTotp(secret, code) ? 'ok' : 'wrong';
  }

  /* ---------------- sessions ---------------- */

  createSession(userAgent?: string): { id: string; expiresAt: number; csrfToken: string } {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.db
      .insert(uiSessions)
      .values({
        idHash: sha256(id),
        createdAt: Date.now(),
        expiresAt,
        userAgent: userAgent?.slice(0, 200) ?? null,
      })
      .run();
    this.db.delete(uiSessions).where(lt(uiSessions.expiresAt, Date.now())).run();
    return { id, expiresAt, csrfToken: this.csrfFor(id) };
  }

  validateSession(id: string | undefined): { id: string } | null {
    if (!id) return null;
    const row = this.db
      .select()
      .from(uiSessions)
      .where(eq(uiSessions.idHash, sha256(id)))
      .get();
    if (!row || row.expiresAt < Date.now()) return null;
    return { id };
  }

  revokeSession(id: string): void {
    this.db
      .delete(uiSessions)
      .where(eq(uiSessions.idHash, sha256(id)))
      .run();
  }

  revokeAllSessions(): void {
    this.db.delete(uiSessions).run();
  }

  csrfFor(sessionId: string): string {
    return this.vault.hmac('csrf', sessionId);
  }

  verifyCsrf(sessionId: string, token: string | undefined): boolean {
    return !!token && this.vault.verifyHmac('csrf', sessionId, token);
  }

  /* ---------------- bearer tokens ---------------- */

  /** Returns the plaintext once; only the hash is stored. Revokes other tokens of the same kind. */
  rotateToken(kind: TokenKind, scope: TokenScope = 'write', label?: string): string {
    const token = `${kind === 'mcp' ? 'spm' : 'spa'}_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    this.db
      .update(tokens)
      .set({ revokedAt: now })
      .where(and(eq(tokens.kind, kind), isNull(tokens.revokedAt)))
      .run();
    this.db
      .insert(tokens)
      .values({
        id: newId(),
        kind,
        scope,
        tokenHash: sha256(token),
        label: label ?? null,
        createdAt: now,
      })
      .run();
    this.audit.record('ui', 'auth.token_rotated', kind, { scope });
    return token;
  }

  hasToken(kind: TokenKind): boolean {
    return !!this.db
      .select({ id: tokens.id })
      .from(tokens)
      .where(and(eq(tokens.kind, kind), isNull(tokens.revokedAt)))
      .get();
  }

  authenticateBearer(header: string | undefined, kind: TokenKind): Principal | null {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return null;
    if (
      kind === 'mcp' &&
      this.bootstrapMcpToken &&
      constantTimeEqual(token, this.bootstrapMcpToken)
    ) {
      return { kind: 'mcp', scope: 'write' };
    }
    const hash = sha256(token);
    const rows = this.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.kind, kind), isNull(tokens.revokedAt)))
      .all();
    for (const row of rows) {
      if (constantTimeEqual(row.tokenHash, hash)) {
        this.db.update(tokens).set({ lastUsedAt: Date.now() }).where(eq(tokens.id, row.id)).run();
        return { kind, scope: row.scope as TokenScope, tokenId: row.id };
      }
    }
    return null;
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against self to keep timing flat, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function verifyTotp(base32: string, code: string): boolean {
  try {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(base32),
    });
    return totp.validate({ token: code.replace(/\s+/g, ''), window: 1 }) !== null;
  } catch {
    return false;
  }
}
