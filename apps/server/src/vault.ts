import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PosterError } from '@poster/core';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 1;

/**
 * AES-256-GCM vault. Layout: [version:1][iv:12][tag:16][ciphertext]. The row id is the AAD so a
 * ciphertext cannot be moved to another row.
 */
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Vault key must be 32 bytes');
  }

  encrypt(aad: string, value: unknown): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALG, this.key, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION]), iv, tag, enc]);
  }

  decrypt<T = unknown>(aad: string, blob: Buffer | Uint8Array): T {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (buf.length < 1 + IV_LEN + TAG_LEN)
      throw new PosterError('INTERNAL', 'Vault: ciphertext too short');
    if (buf[0] !== VERSION)
      throw new PosterError('INTERNAL', `Vault: unsupported version ${buf[0]}`);
    const iv = buf.subarray(1, 1 + IV_LEN);
    const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const data = buf.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALG, this.key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(dec.toString('utf8')) as T;
    } catch (err) {
      throw new PosterError(
        'INTERNAL',
        'Vault: decryption failed (wrong master key or tampered row)',
        { cause: err },
      );
    }
  }

  /** Deterministic keyed MAC for CSRF tokens and similar (never for passwords). */
  hmac(purpose: string, data: string): string {
    return createHmac('sha256', this.key).update(`${purpose}\0${data}`).digest('base64url');
  }

  verifyHmac(purpose: string, data: string, mac: string): boolean {
    const expected = Buffer.from(this.hmac(purpose, data));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

/** Parse a key file: 32 raw bytes, or 64 hex chars, or base64 of 32 bytes (trailing newline ok). */
export function parseKeyMaterial(raw: Buffer): Buffer {
  if (raw.length === 32) return raw;
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const b64 = Buffer.from(text, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('Master key file must contain 32 raw bytes, 64 hex chars, or base64 of 32 bytes');
}

export function loadMasterKey(file: string, opts: { devAutokeyPath?: string } = {}): Buffer {
  if (existsSync(file)) return parseKeyMaterial(readFileSync(file));
  if (opts.devAutokeyPath) {
    if (existsSync(opts.devAutokeyPath)) return parseKeyMaterial(readFileSync(opts.devAutokeyPath));
    const key = randomBytes(32);
    mkdirSync(dirname(opts.devAutokeyPath), { recursive: true });
    writeFileSync(opts.devAutokeyPath, key.toString('hex') + '\n', { mode: 0o600 });
    return key;
  }
  throw new Error(
    `Master key file ${file} not found. Create a Podman secret 'poster_master_key' with 32 random bytes (e.g. 'openssl rand -hex 32'), or set POSTER_DEV_AUTOKEY=1 for development.`,
  );
}
