import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { newId, PosterError } from '@poster/core';
import type { Db } from '../db/index.js';
import { draftCodes } from '../db/schema.js';

/** No 0/O/1/I to avoid transcription mistakes when you type the code in SimpleX. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const MAX_FAILED = 5;

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function normaliseCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/0/g, 'O')
    .replace(/I/g, '1')
    .replace(/1/g, 'I');
}

/**
 * One-time confirmation codes. Only the argon2id hash is stored; issuing a new code invalidates
 * the previous one; 5 wrong guesses invalidate the code.
 */
export class CodeService {
  constructor(
    private readonly db: Db,
    private readonly ttlMinutes: () => number,
  ) {}

  async issue(
    draftId: string,
    deliveredVia: 'direct' | 'returned' | 'none',
  ): Promise<{ code: string; expiresAt: number }> {
    this.invalidate(draftId);
    const code = generateCode();
    const hash = await argon2.hash(code, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    const expiresAt = Date.now() + this.ttlMinutes() * 60_000;
    this.db
      .insert(draftCodes)
      .values({
        id: newId(),
        draftId,
        codeHash: hash,
        expiresAt,
        deliveredVia,
        createdAt: Date.now(),
      })
      .run();
    return { code, expiresAt };
  }

  invalidate(draftId: string): void {
    this.db
      .update(draftCodes)
      .set({ usedAt: Date.now() })
      .where(and(eq(draftCodes.draftId, draftId), isNull(draftCodes.usedAt)))
      .run();
  }

  active(draftId: string): { expiresAt: number; deliveredVia: string } | null {
    const row = this.db
      .select()
      .from(draftCodes)
      .where(and(eq(draftCodes.draftId, draftId), isNull(draftCodes.usedAt)))
      .get();
    if (!row || row.expiresAt < Date.now()) return null;
    return { expiresAt: row.expiresAt, deliveredVia: row.deliveredVia };
  }

  /** Verify and consume. Throws CODE_INVALID / CODE_EXPIRED. */
  async consume(draftId: string, code: string): Promise<void> {
    const row = this.db
      .select()
      .from(draftCodes)
      .where(and(eq(draftCodes.draftId, draftId), isNull(draftCodes.usedAt)))
      .get();
    if (!row)
      throw new PosterError(
        'CODE_EXPIRED',
        'No active confirmation code for this draft. Ask for a new preview.',
      );
    if (row.expiresAt < Date.now()) {
      this.invalidate(draftId);
      throw new PosterError(
        'CODE_EXPIRED',
        'The confirmation code has expired. Ask for a new preview.',
      );
    }
    const candidates = [code.trim().toUpperCase(), normaliseCode(code)];
    let ok = false;
    for (const c of new Set(candidates)) {
      if (await argon2.verify(row.codeHash, c)) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      const failed = row.failedAttempts + 1;
      if (failed >= MAX_FAILED) {
        this.invalidate(draftId);
        throw new PosterError(
          'CODE_INVALID',
          'Wrong code too many times; the code was invalidated. Ask for a new preview.',
        );
      }
      this.db
        .update(draftCodes)
        .set({ failedAttempts: failed })
        .where(eq(draftCodes.id, row.id))
        .run();
      throw new PosterError(
        'CODE_INVALID',
        `Wrong confirmation code (${MAX_FAILED - failed} attempt(s) left).`,
      );
    }
    this.db.update(draftCodes).set({ usedAt: Date.now() }).where(eq(draftCodes.id, row.id)).run();
  }
}
