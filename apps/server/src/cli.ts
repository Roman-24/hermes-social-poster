#!/usr/bin/env node
/**
 * poster CLI (runs inside the container: `podman exec social-poster poster <cmd>`).
 *
 *   poster set-password            Set the UI password (prompts; or POSTER_NEW_PASSWORD env).
 *   poster gen-token mcp|api [--read-only]   Create a bearer token (prints it once, revokes older ones of that kind).
 *   poster rotate-key <new-key-file>         Re-encrypt every secret with a new master key.
 *   poster backup [dir]            Encrypted archive of the DB, settings and browser profiles.
 *   poster self-test               Run the adapter self-tests now.
 *   poster status                  Print account and queue status.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { bootstrap } from './bootstrap.js';
import { nullLogger } from './logger.js';
import { parseKeyMaterial, Vault } from './vault.js';

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(
      readFileSync(new URL(import.meta.url))
        .toString()
        .split('\n')
        .slice(1, 11)
        .join('\n'),
    );
    return;
  }
  const services = await bootstrap({ logger: nullLogger() });
  try {
    switch (cmd) {
      case 'set-password': {
        const pw =
          process.env.POSTER_NEW_PASSWORD ?? (await prompt('New UI password (min 10 chars): '));
        await services.auth.setPassword(pw);
        services.auth.revokeAllSessions();
        services.audit.record('system', 'auth.password_set', null, { via: 'cli' });
        console.log('Password set. Existing UI sessions were revoked.');
        break;
      }
      case 'gen-token': {
        const kind = rest[0];
        if (kind !== 'mcp' && kind !== 'api')
          throw new Error('usage: poster gen-token mcp|api [--read-only]');
        const scope = rest.includes('--read-only') ? 'read' : 'write';
        const token = services.auth.rotateToken(kind, kind === 'mcp' ? 'write' : scope, 'cli');
        console.log(token);
        if (kind === 'mcp') {
          console.error(
            '\nAdd to ~/.hermes/config.yaml:\n  mcp_servers:\n    social_poster:\n      url: "http://127.0.0.1:8787/mcp"\n      headers:\n        Authorization: "Bearer <token above>"\nThen run /reload-mcp in Hermes.',
          );
        }
        break;
      }
      case 'rotate-key': {
        const file = rest[0];
        if (!file) throw new Error('usage: poster rotate-key <new-key-file>');
        const newVault = new Vault(parseKeyMaterial(readFileSync(file)));
        const n1 = services.settings.reencryptAll(newVault);
        const n2 = services.accounts.reencryptAll(newVault);
        services.audit.record('system', 'vault.rotate', null, { secrets: n1, accounts: n2 });
        console.log(
          `Re-encrypted ${n1} secret row(s) and ${n2} account row(s). Now replace the Podman secret with the new key and restart.`,
        );
        break;
      }
      case 'backup': {
        const dir = rest[0] ?? services.config.backupDir;
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const out = join(dir, `poster-backup-${stamp}.tar.gz.enc`);
        services.sqlite.pragma('wal_checkpoint(TRUNCATE)');
        // tar (DB + browser profiles + settings live in the DB) → AES-256-GCM with the master key.
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', vaultKey(services.vault), iv);
        const ws = createWriteStream(out);
        ws.write(Buffer.concat([Buffer.from('PBK1'), iv]));
        const tar = spawn(
          'tar',
          [
            '-C',
            services.config.DATA_DIR,
            '-czf',
            '-',
            'app.db',
            ...(existsSync(services.config.browserDir) ? ['browser'] : []),
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        await new Promise<void>((resolve, reject) => {
          tar.stdout.on('data', (chunk: Buffer) => ws.write(cipher.update(chunk)));
          tar.on('error', reject);
          tar.on('close', (code) => {
            if (code !== 0) return reject(new Error(`tar exited with ${code}`));
            ws.write(cipher.final());
            ws.write(cipher.getAuthTag());
            ws.end(resolve);
          });
        });
        services.audit.record('system', 'backup.create', null, { out });
        console.log(
          `Backup written to ${out}\nRestore: tail -c +17 FILE | openssl enc -d -aes-256-gcm ... is not possible with GCM in openssl; use \`poster restore FILE\`.`,
        );
        break;
      }
      case 'restore': {
        const file = rest[0];
        if (!file)
          throw new Error('usage: poster restore <backup-file> (run while the server is stopped)');
        const { createDecipheriv } = await import('node:crypto');
        const buf = readFileSync(file);
        if (buf.subarray(0, 4).toString() !== 'PBK1') throw new Error('not a poster backup');
        const iv = buf.subarray(4, 16);
        const tag = buf.subarray(buf.length - 16);
        const data = buf.subarray(16, buf.length - 16);
        const decipher = createDecipheriv('aes-256-gcm', vaultKey(services.vault), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(data), decipher.final()]);
        services.sqlite.close();
        const tar = spawn('tar', ['-C', services.config.DATA_DIR, '-xzf', '-'], {
          stdio: ['pipe', 'inherit', 'inherit'],
        });
        tar.stdin.end(plain);
        await new Promise<void>((resolve, reject) =>
          tar.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)),
          ),
        );
        console.log('Restored. Start the server again.');
        return;
      }
      case 'self-test': {
        const r = await services.jobs.runSelfTests();
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'status': {
        const views = await services.accounts.listViews(false);
        for (const v of views)
          console.log(
            `${v.network.padEnd(10)} ${v.status.padEnd(13)} ${v.handle ?? ''} ${v.warnings.join(' / ')}`,
          );
        console.log(JSON.stringify(services.posts.counts()));
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } finally {
    await services.shutdown().catch(() => undefined);
  }
}

async function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

/** The Vault keeps its key private; derive a backup key from it so backups need only the master key. */
function vaultKey(vault: Vault): Buffer {
  return Buffer.from(vault.hmac('backup', 'v1'), 'base64url').subarray(0, 32);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
