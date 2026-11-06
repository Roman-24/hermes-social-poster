import argon2 from 'argon2';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
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
 * One-time confirmation codes. Only the argon2id hash is stored.
 *
 * - A code is bound to a digest of the draft content it was issued for. It confirms exactly that
 *   content and nothing else, so a draft that changes after the human saw it cannot be confirmed
 *   with the old code.
 * - Issuing a code invalidates the previous one in the same synchronous transaction, so a draft
 *   never has two live codes.
 * - Each guess spends one attempt in a single conditional UPDATE before the slow argon2 check, so
 *   concurrent guesses cannot share one counter value: at most MAX_FAILED guesses are ever
 *   verified per code, however many requests are in flight.
 */
export class CodeService {
  constructor(
    private readonly db: Db,
    private readonly ttlMinutes: () => number,
  ) {}

  async issue(
    draftId: string,
    deliveredVia: 'direct' | 'returned' | 'none',
    contentDigest: string,
  ): Promise<{ code: string; expiresAt: number }> {
    const code = generateCode();
    // The slow hash comes first so that invalidate-and-insert below has no await in between.
    const hash = await argon2.hash(code, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    const expiresAt = Date.now() + this.ttlMinutes() * 60_000;
    this.db.transaction((tx) => {
      tx.update(draftCodes)
        .set({ usedAt: Date.now() })
        .where(and(eq(draftCodes.draftId, draftId), isNull(draftCodes.usedAt)))
        .run();
      tx.insert(draftCodes)
        .values({
          id: newId(),
          draftId,
          codeHash: hash,
          contentDigest,
          expiresAt,
          deliveredVia,
          createdAt: Date.now(),
        })
        .run();
    });
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

  /**
   * Verify and consume. Throws CODE_INVALID / CODE_EXPIRED.
   *
   * `currentDigest` is called after the slow verification and must read the draft content
   * synchronously. The code is burned only if that digest still equals the one it was issued for.
   * Returns the digest that was approved so the caller can re-check it before committing.
   */
  async consume(draftId: string, code: string, currentDigest: () => string): Promise<string> {
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
    // Spend an attempt atomically before verifying. This is one statement, so concurrent guesses
    // each get a distinct counter value and the sixth one is refused without running argon2.
    const spent = this.db
      .update(draftCodes)
      .set({ failedAttempts: sql`${draftCodes.failedAttempts} + 1` })
      .where(
        and(
          eq(draftCodes.id, row.id),
          isNull(draftCodes.usedAt),
          lt(draftCodes.failedAttempts, MAX_FAILED),
        ),
      )
      .returning({ n: draftCodes.failedAttempts })
      .get();
    if (!spent) {
      this.invalidate(draftId);
      throw new PosterError(
        'CODE_INVALID',
        'Wrong code too many times; the code was invalidated. Ask for a new preview.',
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
      if (spent.n >= MAX_FAILED) {
        this.invalidate(draftId);
        throw new PosterError(
          'CODE_INVALID',
          'Wrong code too many times; the code was invalidated. Ask for a new preview.',
        );
      }
      throw new PosterError(
        'CODE_INVALID',
        `Wrong confirmation code (${MAX_FAILED - spent.n} attempt(s) left).`,
      );
    }
    // Burn the code only if it is still unused and the draft still has the content it was
    // issued for. A concurrent confirm that already used it, or an update that changed the
    // draft while the hash was being checked, makes this statement change no row.
    const digest = currentDigest();
    const burned = this.db
      .update(draftCodes)
      .set({ usedAt: Date.now() })
      .where(
        and(
          eq(draftCodes.id, row.id),
          isNull(draftCodes.usedAt),
          eq(draftCodes.contentDigest, digest),
        ),
      )
      .run();
    if (burned.changes !== 1) {
      this.invalidate(draftId);
      throw new PosterError(
        'CODE_EXPIRED',
        'The draft changed after this code was issued, or the code was already used. Ask for a new preview.',
      );
    }
    return digest;
  }
}
