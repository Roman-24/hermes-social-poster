import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseKeyMaterial, Vault } from './vault.js';

describe('Vault', () => {
  const vault = new Vault(randomBytes(32));

  it('round-trips JSON values', () => {
    const enc = vault.encrypt('row-1', { a: 1, b: 'x', nested: { c: [1, 2] } });
    expect(vault.decrypt('row-1', enc)).toEqual({ a: 1, b: 'x', nested: { c: [1, 2] } });
  });

  it('rejects ciphertext moved to another row (AAD mismatch)', () => {
    const enc = vault.encrypt('row-1', 'secret');
    expect(() => vault.decrypt('row-2', enc)).toThrow(/decryption failed/);
  });

  it('rejects tampered ciphertext', () => {
    const enc = vault.encrypt('row-1', 'secret');
    enc[enc.length - 1] ^= 0xff;
    expect(() => vault.decrypt('row-1', enc)).toThrow();
  });

  it('uses a fresh IV per encryption', () => {
    const a = vault.encrypt('r', 'same');
    const b = vault.encrypt('r', 'same');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a wrong key', () => {
    const other = new Vault(randomBytes(32));
    const enc = vault.encrypt('r', 'x');
    expect(() => other.decrypt('r', enc)).toThrow();
  });

  it('parses raw, hex and base64 key files', () => {
    const raw = randomBytes(32);
    expect(parseKeyMaterial(raw).equals(raw)).toBe(true);
    expect(parseKeyMaterial(Buffer.from(raw.toString('hex') + '\n')).equals(raw)).toBe(true);
    expect(parseKeyMaterial(Buffer.from(raw.toString('base64'))).equals(raw)).toBe(true);
    expect(() => parseKeyMaterial(Buffer.from('short'))).toThrow();
  });

  it('HMAC verifies and rejects', () => {
    const mac = vault.hmac('csrf', 'session');
    expect(vault.verifyHmac('csrf', 'session', mac)).toBe(true);
    expect(vault.verifyHmac('csrf', 'other', mac)).toBe(false);
    expect(vault.verifyHmac('csrf', 'session', 'nope')).toBe(false);
  });
});
