import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import {
  CancelPostInputSchema,
  ConfirmPostInputSchema,
  CreateDraftInputSchema,
  GetPostInputSchema,
  ListPostsInputSchema,
  NETWORK_LABELS,
  PosterError,
  ReschedulePostInputSchema,
  UpdateDraftInputSchema,
  UploadMediaInputSchema,
  type AccountView,
  type DraftPreview,
  type PostView,
} from '@poster/core';
import type { Services } from '../bootstrap.js';
import type { AuthHooks } from '../http/auth-hooks.js';

const PREAMBLE =
  'Always show the user the FULL preview (every network, every part, the resolved time in their zone and in UTC, and all warnings). ' +
  'Never invent, guess or reuse a confirmation code: the code reaches the user directly in SimpleX and only they can give it to you. ' +
  'Pass times with an explicit zone ("2026-11-02T09:00:00+01:00" or {at, tz}); the default zone is the user\'s configured zone.';

/**
 * MCP tools for Hermes over Streamable HTTP at POST /mcp (stateless: one server per request).
 * Every tool calls the same service layer and zod schemas as REST.
 */
export function buildMcpServer(services: Services): McpServer {
  const { posts, accounts, media } = services;
  const server = new McpServer(
    { name: 'social-poster', version: '0.1.0' },
    { instructions: PREAMBLE },
  );

  const wrap =
    <T>(fn: () => Promise<{ text: string; data: T }>) =>
    async (): Promise<CallToolResult> => {
      try {
        const { text, data } = await fn();
        return {
          content: [{ type: 'text', text }],
          structuredContent: data as Record<string, unknown>,
        };
      } catch (err) {
        const pe = PosterError.from(err);
        services.logger.warn({ err: pe, code: pe.code }, 'mcp tool failed');
        return {
          isError: true,
          content: [{ type: 'text', text: `Error ${pe.code}: ${pe.message}` }],
          structuredContent: { error: pe.toProblem() },
        };
      }
    };

  server.registerTool(
    'list_networks',
    {
      title: 'List networks',
      description:
        'Connection status, handle, limits and warnings for each network (X, Farcaster, LinkedIn, Nostr, Bluesky).',
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const views = await accounts.listViews(false);
      return { text: renderNetworks(views), data: { networks: views.map(stripLimits) } };
    }),
  );

  server.registerTool(
    'create_draft',
    {
      title: 'Create draft',
      description:
        'Create a draft post for one or more networks and return the per-network preview. ' +
        'Does NOT publish: the user must confirm with the code they receive in SimpleX (then call confirm_post). ' +
        'Media: pass mediaPaths (SimpleX inbox paths) or mediaIds from upload_media. ' +
        PREAMBLE,
      inputSchema: CreateDraftInputSchema.shape,
    },
    (args) =>
      wrap(async () => {
        const preview = await posts.createDraft(CreateDraftInputSchema.parse(args), 'mcp');
        return { text: renderPreview(preview), data: preview };
      })(),
  );

  server.registerTool(
    'update_draft',
    {
      title: 'Update draft',
      description:
        'Change any field of a draft (text, networks, overrides, media, schedule, thread mode). Returns a new preview; the previous code is invalidated and a new one is sent to the user.',
      inputSchema: UpdateDraftInputSchema.shape,
    },
    (args) =>
      wrap(async () => {
        const preview = await posts.updateDraft(UpdateDraftInputSchema.parse(args), 'mcp');
        return { text: renderPreview(preview), data: preview };
      })(),
  );

  server.registerTool(
    'confirm_post',
    {
      title: 'Confirm post',
      description:
        'Confirm a draft with the confirmation code the user typed (e.g. from "yes ABC123"). The post becomes scheduled (or queued when "now"). Only call this after the user explicitly gave you the code.',
      inputSchema: ConfirmPostInputSchema.shape,
    },
    (args) =>
      wrap(async () => {
        const input = ConfirmPostInputSchema.parse(args);
        const r = await posts.confirm(input.draftId, {
          trusted: false,
          code: input.code,
          actor: 'mcp',
        });
        return {
          text: `Confirmed. Post ${r.postId} is ${r.status} for ${r.schedule.display} (${r.schedule.isoUtc}).`,
          data: r,
        };
      })(),
  );

  server.registerTool(
    'cancel_post',
    {
      title: 'Cancel post',
      description:
        'Cancel a draft or a scheduled post, optionally only for some networks. Targets already publishing or published cannot be cancelled.',
      inputSchema: CancelPostInputSchema.shape,
    },
    (args) =>
      wrap(async () => {
        const r = posts.cancel(CancelPostInputSchema.parse(args), 'mcp');
        const nc = r.notCancelled
          .map((n) => `${NETWORK_LABELS[n.network]} (${n.reason})`)
          .join(', ');
        return {
          text: `Post ${r.postId} is now ${r.status}. Cancelled: ${r.cancelled.map((n) => NETWORK_LABELS[n]).join(', ') || 'nothing'}.${nc ? ` Not cancelled: ${nc}.` : ''}`,
          data: r,
        };
      })(),
  );

  server.registerTool(
    'reschedule_post',
    {
      title: 'Reschedule post',
      description:
        'Move a scheduled, failed or missed post to a new time (optionally only some networks). Returns a new preview and sends a NEW confirmation code: the user must confirm again with confirm_post(draftId = postId, code).',
      inputSchema: ReschedulePostInputSchema.shape,
    },
    (args) =>
      wrap(async () => {
        const input = ReschedulePostInputSchema.parse(args);
        const r = (await posts.reschedule(
          input.postId,
          input.schedule,
          input.networks,
          'mcp',
          false,
        )) as DraftPreview;
        return { text: renderPreview(r), data: r };
      })(),
  );

  server.registerTool(
    'get_post',
    {
      title: 'Get post',
      description: 'State, published URLs and errors per network for one post or draft.',
      inputSchema: GetPostInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      wrap(async () => {
        const v = posts.get(GetPostInputSchema.parse(args).postId, false);
        return { text: renderPost(v), data: v };
      })(),
  );

  server.registerTool(
    'list_posts',
    {
      title: 'List posts',
      description:
        'Upcoming queue or history. Filter by status (draft, scheduled, queued, publishing, published, partially_published, failed, cancelled, expired) and date range.',
      inputSchema: ListPostsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      wrap(async () => {
        const r = posts.list(ListPostsInputSchema.parse(args));
        const text = r.items.length
          ? r.items
              .map(
                (p) =>
                  `• ${p.id} [${p.status}] ${p.schedule.display} → ${p.targets.map((t) => `${NETWORK_LABELS[t.network]}:${t.status}`).join(' ')} — ${excerpt(p.baseText)}`,
              )
              .join('\n')
          : 'No posts match.';
        return {
          text: `${text}${r.nextCursor ? `\n(more: cursor ${r.nextCursor})` : ''}`,
          data: r,
        };
      })(),
  );

  server.registerTool(
    'upload_media',
    {
      title: 'Upload media',
      description:
        'Register an image or video from the SimpleX inbox (absolute path as reported by the daemon). Returns a mediaId plus per-network compatibility to use in create_draft.',
      inputSchema: UploadMediaInputSchema.shape,
    },
    (args) =>
      wrap(async () => {
        const input = UploadMediaInputSchema.parse(args);
        const r = await media.ingestFromInbox(input.path, input.altText);
        const compat = Object.entries(r.compatibility)
          .map(
            ([n, c]) =>
              `${NETWORK_LABELS[n as keyof typeof NETWORK_LABELS]}: ${c.ok ? 'ok' : `no (${c.reason})`}`,
          )
          .join(', ');
        return {
          text: `Media ${r.id}: ${r.kind} ${r.mime}, ${Math.round(r.bytes / 1024)} KB${r.width ? `, ${r.width}×${r.height}` : ''}${r.durationMs ? `, ${Math.round(r.durationMs / 1000)} s` : ''}. ${compat}`,
          data: r,
        };
      })(),
  );

  return server;
}

/** Fastify route: stateless Streamable HTTP, one transport + server per request. */
export async function mcpRoutes(
  app: FastifyInstance,
  services: Services,
  hooks: AuthHooks,
): Promise<void> {
  const handler = async (
    request: Parameters<typeof hooks.requireMcp>[0],
    reply: Parameters<typeof hooks.requireMcp>[1],
  ) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = buildMcpServer(services);
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      services.logger.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    } finally {
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
    }
  };
  app.post('/mcp', { preHandler: hooks.requireMcp }, handler);
  app.get('/mcp', { preHandler: hooks.requireMcp }, handler);
  app.delete('/mcp', { preHandler: hooks.requireMcp }, handler);
}

/* ---------------- text renderers (what the agent shows the user) ---------------- */

function stripLimits(v: AccountView) {
  return {
    network: v.network,
    connected: v.connected,
    status: v.status,
    handle: v.handle,
    expiresAt: v.expiresAt,
    warnings: v.warnings,
    limits: {
      text: v.limits.text,
      images: v.limits.images.max,
      video: !!v.limits.video,
      threads: v.limits.threads,
    },
  };
}

function renderNetworks(views: AccountView[]): string {
  return views
    .map((v) => {
      const lim = `${v.limits.text.max} ${v.limits.text.unit}, ${v.limits.images.max} images, video ${v.limits.video ? 'yes' : 'no'}, threads ${v.limits.threads ? 'yes' : 'no'}`;
      const warn = v.warnings.length ? ` ⚠ ${v.warnings.join(' / ')}` : '';
      return `• ${NETWORK_LABELS[v.network]}: ${v.connected ? `connected as ${v.handle ?? '?'}` : v.status} (${lim})${warn}`;
    })
    .join('\n');
}

export function renderPreview(p: DraftPreview): string {
  const lines: string[] = [];
  lines.push(
    `Draft ${p.draftId} — ${p.schedule.immediate ? 'publish immediately' : `scheduled for ${p.schedule.display} = ${p.schedule.isoUtc}`}`,
  );
  for (const n of p.previews) {
    const sched = n.schedule.atUtcMs !== p.schedule.atUtcMs ? ` (at ${n.schedule.display})` : '';
    lines.push(
      '',
      `[${NETWORK_LABELS[n.network]}${n.handle ? ` ${n.handle}` : ''}${n.connected ? '' : ' — NOT CONNECTED'}]${sched}${n.thread ? ` thread of ${n.parts.length}` : ''}`,
    );
    n.parts.forEach((part, i) => {
      const bytes = part.bytes !== undefined ? `, ${part.bytes}/${part.maxBytes} bytes` : '';
      const mediaNote = part.media.length
        ? ` +${part.media.length} media (${part.media.map((m) => m.kind).join(', ')})`
        : '';
      lines.push(
        `${n.parts.length > 1 ? `  ${i + 1}/${n.parts.length} ` : '  '}(${part.count}/${part.max} ${part.unit}${bytes})${mediaNote}`,
      );
      lines.push(...part.text.split('\n').map((l) => `  | ${l}`));
    });
    for (const i of n.issues)
      lines.push(`  ${i.level === 'error' ? '✖' : i.level === 'warning' ? '⚠' : 'ℹ'} ${i.message}`);
  }
  if (p.errors.length) lines.push('', `Cannot be confirmed until fixed: ${p.errors.join(' | ')}`);
  lines.push('');
  if (p.codeDelivery === 'direct')
    lines.push(
      'A confirmation code was sent to the user in SimpleX. Ask them to reply "yes <code>" (or "cancel"), then call confirm_post.',
    );
  else if (p.codeDelivery === 'returned')
    lines.push(
      `Confirmation code (soft mode, no direct Hermes route configured): ${p.code}. Show the preview and ask the user to confirm with this code.`,
    );
  else lines.push('No code issued (draft has errors). Fix them with update_draft.');
  if (p.codeExpiresAt) lines.push(`Code expires at ${new Date(p.codeExpiresAt).toISOString()}.`);
  return lines.join('\n');
}

function renderPost(v: PostView): string {
  const lines = [
    `Post ${v.id} [${v.status}] — ${v.schedule.display} (${v.schedule.isoUtc})`,
    excerpt(v.baseText, 200),
  ];
  for (const t of v.targets) {
    const err = t.lastErrorCode ? ` — ${t.lastErrorCode}: ${t.lastErrorMessage ?? ''}` : '';
    lines.push(
      `• ${NETWORK_LABELS[t.network]}: ${t.status}${t.publishedUrl ? ` ${t.publishedUrl}` : ''}${t.attempts ? ` (${t.attempts} attempt${t.attempts > 1 ? 's' : ''})` : ''}${err}`,
    );
  }
  return lines.join('\n');
}

function excerpt(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
