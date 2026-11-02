import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DraftPreview } from '@poster/core';
import { createTestEnv, type TestEnv } from './test-helpers.js';

let env: TestEnv;
let baseUrl: string;

beforeEach(async () => {
  env = await createTestEnv();
  const address = await env.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address.replace('[::1]', '127.0.0.1');
  // The Host check must accept the random port.
  env.services.settings.update({ allowedHosts: [new URL(baseUrl).host] });
});
afterEach(async () => {
  await env.cleanup();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe('MCP (Streamable HTTP)', () => {
  it('rejects a bad bearer token', async () => {
    await expect(connect('wrong')).rejects.toThrow();
  });

  it('lists tools and runs create_draft → confirm_post → get_post', async () => {
    const client = await connect('test-mcp-token');
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        'cancel_post',
        'confirm_post',
        'create_draft',
        'get_post',
        'list_networks',
        'list_posts',
        'reschedule_post',
        'update_draft',
        'upload_media',
      ].sort(),
    );

    const nets = await client.callTool({ name: 'list_networks', arguments: {} });
    expect((nets.content as { type: string; text: string }[])[0]?.text).toContain(
      'Nostr: connected as @fake_nostr',
    );

    const created = await client.callTool({
      name: 'create_draft',
      arguments: { text: 'Hello via MCP', networks: ['nostr'], schedule: 'now' },
    });
    expect(created.isError).toBeFalsy();
    const preview = created.structuredContent as DraftPreview;
    expect(preview.codeDelivery).toBe('returned');
    const text = (created.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('[Nostr @fake_nostr]');
    expect(text).toContain('Confirmation code (soft mode');

    const bad = await client.callTool({
      name: 'confirm_post',
      arguments: { draftId: preview.draftId, code: 'NOPE22' },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]?.text).toContain('CODE_INVALID');

    const ok = await client.callTool({
      name: 'confirm_post',
      arguments: { draftId: preview.draftId, code: preview.code! },
    });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { status: string }).status).toBe('queued');

    await env.services.scheduler.tick();
    await env.services.scheduler.stop();

    const got = await client.callTool({ name: 'get_post', arguments: { postId: preview.draftId } });
    expect((got.structuredContent as { status: string }).status).toBe('published');

    const list = await client.callTool({
      name: 'list_posts',
      arguments: { status: ['published'] },
    });
    expect((list.structuredContent as { items: unknown[] }).items).toHaveLength(1);
    await client.close();
  });

  it('reschedule_post returns a new preview and code, and cancel works', async () => {
    const client = await connect('test-mcp-token');
    const created = await client.callTool({
      name: 'create_draft',
      arguments: {
        text: 'Later',
        networks: ['bluesky'],
        schedule: { at: '2027-06-01 09:00', tz: 'Europe/Prague' },
      },
    });
    const preview = created.structuredContent as DraftPreview;
    await client.callTool({
      name: 'confirm_post',
      arguments: { draftId: preview.draftId, code: preview.code! },
    });

    const re = await client.callTool({
      name: 'reschedule_post',
      arguments: { postId: preview.draftId, schedule: '2027-07-01T10:00:00+02:00' },
    });
    expect(re.isError, JSON.stringify(re.content)).toBeFalsy();
    const p2 = re.structuredContent as DraftPreview;
    expect(p2.status).toBe('draft');
    expect(p2.code).toBeDefined();
    expect(p2.code).not.toBe(preview.code);
    expect(p2.previews[0]?.schedule.isoUtc).toBe('2027-07-01T08:00:00Z');

    const cancelled = await client.callTool({
      name: 'cancel_post',
      arguments: { draftId: preview.draftId },
    });
    expect((cancelled.structuredContent as { status: string }).status).toBe('cancelled');
    await client.close();
  });

  it('never leaks secrets through list_networks', async () => {
    const client = await connect('test-mcp-token');
    const nets = await client.callTool({ name: 'list_networks', arguments: {} });
    const json = JSON.stringify(nets.structuredContent);
    expect(json).not.toContain('"token"');
    expect(json).not.toContain('secrets');
    await client.close();
  });
});
