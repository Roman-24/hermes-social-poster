import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '@poster/adapters';
import { NETWORKS, type Network } from '@poster/core';
import type { FastifyInstance } from 'fastify';
import { bootstrap, type Services } from './bootstrap.js';
import { buildApp } from './http/app.js';
import { nullLogger } from './logger.js';
import type { AdapterRegistry } from './services/accounts.js';
import type { NotifyFetch } from './services/notifier.js';

export interface TestEnv {
  services: Services;
  app: FastifyInstance;
  fakes: Record<Network, ReturnType<typeof createFakeAdapter>>;
  dataDir: string;
  inboxDir: string;
  webhookCalls: { url: string; headers: Record<string, string>; body: unknown }[];
  /** Log in as UI and return cookie + csrf headers. */
  login(): Promise<{ cookie: string; csrf: string }>;
  cleanup(): Promise<void>;
}

export async function createTestEnv(
  opts: { env?: Record<string, string>; webhookStatus?: number; softMode?: boolean } = {},
): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'poster-data-'));
  const inboxDir = mkdtempSync(join(tmpdir(), 'poster-inbox-'));
  const fakes = Object.fromEntries(NETWORKS.map((n) => [n, createFakeAdapter(n)])) as Record<
    Network,
    ReturnType<typeof createFakeAdapter>
  >;
  const webhookCalls: TestEnv['webhookCalls'] = [];
  const fetchImpl: NotifyFetch = async (url, init) => {
    webhookCalls.push({
      url,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init.body)),
    });
    return new Response('ok', { status: opts.webhookStatus ?? 200 });
  };
  const services = await bootstrap({
    env: {
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      INBOX_DIR: inboxDir,
      INBOX_HOST_PREFIX: '/host/inbox',
      POSTER_FAKE_ADAPTERS: '1',
      POSTER_MCP_TOKEN: 'test-mcp-token',
      POSTER_UI_PASSWORD: 'correct horse battery',
      PORT: '8787',
      ...(opts.env ?? {}),
    },
    dbPath: ':memory:',
    masterKey: randomBytes(32),
    logger: nullLogger(),
    adapters: fakes as unknown as AdapterRegistry,
    fetchImpl,
  });
  // Soft mode (the code is returned to the caller) is off by default in production; most tests
  // need the code in the tool result, so they switch it on here. Pass softMode: false to test the
  // default.
  services.settings.update({ hermes: { allowSoftMode: opts.softMode ?? true } });
  const app = await buildApp(services);
  await app.ready();

  // Connect every fake account.
  for (const n of NETWORKS) {
    await services.accounts.saveConnection(
      n,
      { handle: `@fake_${n}`, secrets: { token: 'x' }, meta: {} },
      'system',
    );
  }

  return {
    services,
    app,
    fakes,
    dataDir,
    inboxDir,
    webhookCalls,
    async login() {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { host: '127.0.0.1:8787' },
        payload: { password: 'correct horse battery' },
      });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
      const setCookie = res.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
      return { cookie, csrf: (res.json() as { csrfToken: string }).csrfToken };
    },
    async cleanup() {
      await app.close();
      await services.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(inboxDir, { recursive: true, force: true });
    },
  };
}

export const HOST = { host: '127.0.0.1:8787' };
