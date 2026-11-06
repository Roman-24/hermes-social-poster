import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { expectOk, fetchWithTimeout, readJson, safeText } from './http.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** Headers go out at once, then one byte every 40 ms for several seconds. */
const trickle: Parameters<typeof createServer>[1] = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(' ');
  const t = setInterval(() => res.write(' '), 40);
  res.on('close', () => clearInterval(t));
};

describe('HTTP helper bounds the whole exchange, not only the headers', () => {
  it('times out a body that trickles in after the headers', async () => {
    const base = await serve(trickle);
    const t0 = Date.now();
    const res = await fetchWithTimeout(base, { timeoutMs: 300 });
    await expect(readJson(res, 'Test')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it('stops reading when the caller aborts after the headers', async () => {
    const base = await serve(trickle);
    const ac = new AbortController();
    const res = await fetchWithTimeout(base, { timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(new Error('caller gave up')), 100);
    const t0 = Date.now();
    await expect(readJson(res, 'Test')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it('refuses an oversized JSON body without buffering all of it', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(8 * 1024 * 1024, 0x20));
    });
    const res = await fetchWithTimeout(base);
    await expect(readJson(res, 'Test')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringContaining('larger than'),
    });
  });

  it('reads only a bounded slice of an error body and still maps the status', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(Buffer.alloc(8 * 1024 * 1024, 0x41));
    });
    const res = await fetchWithTimeout(base);
    await expect(expectOk(res, { service: 'Test' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    const again = await fetchWithTimeout(base);
    expect((await safeText(again)).length).toBeLessThanOrEqual(16 * 1024);
  });

  it('still parses an ordinary small reply', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const res = await fetchWithTimeout(base, { timeoutMs: 1_000 });
    expect(await readJson<{ ok: boolean }>(res, 'Test')).toEqual({ ok: true });
  });
});
