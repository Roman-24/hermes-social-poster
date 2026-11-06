import { z } from 'zod';
import { IssueSchema } from './issues.js';
import { MediaInfoSchema } from './media.js';
import { NetworkSchema } from './networks.js';
import { ScheduleInputSchema } from './schedule.js';
import { AccountStatusSchema, PostStatusSchema, TargetStatusSchema } from './states.js';

/* ------------------------------------------------------------------ */
/* Inputs (shared by MCP tools and REST)                               */
/* ------------------------------------------------------------------ */

/**
 * Input bounds. Every field that reaches the renderer or the thread splitter is capped so that
 * one request cannot occupy the single-threaded server for long. The caps sit well above anything
 * a real post needs: the longest thread is 25 parts of a few hundred characters, and the highest
 * default attachment count of any network is 20 (LinkedIn images).
 */
export const MAX_POST_TEXT = 10_000;
export const MAX_ATTACHMENTS = 20;
const MediaIdSchema = z.string().min(1).max(64);

export const OverrideSchema = z.object({
  text: z
    .string()
    .max(MAX_POST_TEXT)
    .optional()
    .describe('Replace the base text for this network only'),
  mediaIds: z
    .array(MediaIdSchema)
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe('Replace the media for this network only'),
});

export const CreateDraftInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_POST_TEXT)
    .describe('Base text. Use a line containing only --- to force thread part breaks.'),
  networks: z.array(NetworkSchema).min(1).max(5).describe('Networks to publish to'),
  overrides: z
    .partialRecord(NetworkSchema, OverrideSchema)
    .optional()
    .describe('Per-network text/media overrides'),
  mediaPaths: z
    .array(z.string().min(1).max(1024))
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe(
      'Absolute file paths reported by the SimpleX daemon (must be inside the inbox directory)',
    ),
  mediaIds: z
    .array(MediaIdSchema)
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe('Ids returned by upload_media'),
  altTexts: z
    .array(z.string().max(4096))
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe('Alt text per media item, in order'),
  schedule: ScheduleInputSchema.optional().describe(
    '"now" (default), ISO 8601 with offset, or {at, tz}',
  ),
  scheduleOverrides: z
    .partialRecord(NetworkSchema, ScheduleInputSchema)
    .optional()
    .describe('Per-network schedule'),
  thread: z
    .enum(['auto', 'off'])
    .default('auto')
    .describe('auto: split over-limit text into a thread; off: over-limit is an error'),
});
export type CreateDraftInput = z.infer<typeof CreateDraftInputSchema>;

export const UpdateDraftInputSchema = CreateDraftInputSchema.partial().extend({
  draftId: z.string(),
  // .partial() keeps the create default, which would silently reset an existing draft to 'auto'
  // whenever an update leaves the field out.
  thread: z.enum(['auto', 'off']).optional().describe('auto: split over-limit text; off: error'),
});
export type UpdateDraftInput = z.infer<typeof UpdateDraftInputSchema>;

export const ConfirmPostInputSchema = z.object({
  draftId: z.string(),
  code: z
    .string()
    .min(4)
    .max(12)
    .describe('The 6-character confirmation code the user received in SimpleX'),
});
export type ConfirmPostInput = z.infer<typeof ConfirmPostInputSchema>;

export const CancelPostInputSchema = z
  .object({
    postId: z.string().optional(),
    draftId: z.string().optional(),
    networks: z.array(NetworkSchema).optional().describe('Only cancel these networks'),
  })
  .refine((v) => v.postId || v.draftId, { message: 'postId or draftId is required' });
export type CancelPostInput = z.infer<typeof CancelPostInputSchema>;

export const ReschedulePostInputSchema = z.object({
  postId: z.string(),
  schedule: ScheduleInputSchema,
  networks: z.array(NetworkSchema).optional(),
});
export type ReschedulePostInput = z.infer<typeof ReschedulePostInputSchema>;

export const GetPostInputSchema = z.object({ postId: z.string() });

export const ListPostsInputSchema = z.object({
  status: z.array(PostStatusSchema).optional(),
  from: z.string().optional().describe('ISO date-time, inclusive'),
  to: z.string().optional().describe('ISO date-time, exclusive'),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListPostsInput = z.infer<typeof ListPostsInputSchema>;

export const UploadMediaInputSchema = z.object({
  path: z.string().describe('Absolute file path inside the inbox directory'),
  altText: z.string().optional(),
});
export type UploadMediaInput = z.infer<typeof UploadMediaInputSchema>;

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export const ScheduleViewSchema = z.object({
  atUtcMs: z.number().int(),
  tz: z.string(),
  isoLocal: z.string(),
  isoUtc: z.string(),
  display: z.string(),
  immediate: z.boolean(),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

export const MediaSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video']),
  mime: z.string(),
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  altText: z.string().nullable(),
});
export type MediaSummary = z.infer<typeof MediaSummarySchema>;

export const PartPreviewSchema = z.object({
  text: z.string(),
  count: z.number().int(),
  max: z.number().int(),
  unit: z.string(),
  bytes: z.number().int().optional(),
  maxBytes: z.number().int().optional(),
  media: z.array(MediaSummarySchema),
});

export const NetworkPreviewSchema = z.object({
  network: NetworkSchema,
  connected: z.boolean(),
  handle: z.string().nullable(),
  thread: z.boolean(),
  parts: z.array(PartPreviewSchema),
  schedule: ScheduleViewSchema,
  issues: z.array(IssueSchema),
});
export type NetworkPreview = z.infer<typeof NetworkPreviewSchema>;

export const DraftPreviewSchema = z.object({
  draftId: z.string(),
  status: PostStatusSchema,
  previews: z.array(NetworkPreviewSchema),
  schedule: ScheduleViewSchema,
  warnings: z.array(z.string()),
  /** Hard errors; the draft cannot be confirmed until they are fixed via update_draft. */
  errors: z.array(z.string()),
  codeDelivery: z.enum(['direct', 'returned', 'none']),
  /** Only present in soft mode (no direct route configured). */
  code: z.string().optional(),
  codeExpiresAt: z.number().int().nullable(),
  expiresAt: z.number().int(),
});
export type DraftPreview = z.infer<typeof DraftPreviewSchema>;

export const AttemptViewSchema = z.object({
  id: z.string(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  outcome: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  screenshot: z.string().nullable(),
});
export type AttemptView = z.infer<typeof AttemptViewSchema>;

export const TargetViewSchema = z.object({
  id: z.string(),
  network: NetworkSchema,
  status: TargetStatusSchema,
  schedule: ScheduleViewSchema,
  attempts: z.number().int(),
  nextAttemptAt: z.number().int().nullable(),
  publishedUrl: z.string().nullable(),
  remoteIds: z.array(z.string()),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  text: z.string(),
  parts: z.array(z.string()),
  attemptLog: z.array(AttemptViewSchema).optional(),
});
export type TargetView = z.infer<typeof TargetViewSchema>;

export const PostViewSchema = z.object({
  id: z.string(),
  status: PostStatusSchema,
  baseText: z.string(),
  threadMode: z.enum(['auto', 'off']),
  schedule: ScheduleViewSchema,
  source: z.enum(['mcp', 'ui', 'api']),
  createdAt: z.number().int(),
  confirmedAt: z.number().int().nullable(),
  targets: z.array(TargetViewSchema),
  media: z.array(MediaSummarySchema),
});
export type PostView = z.infer<typeof PostViewSchema>;

export const PostListSchema = z.object({
  items: z.array(PostViewSchema),
  nextCursor: z.string().nullable(),
});
export type PostList = z.infer<typeof PostListSchema>;

export const ConfirmResultSchema = z.object({
  postId: z.string(),
  status: PostStatusSchema,
  schedule: ScheduleViewSchema,
});

export const CancelResultSchema = z.object({
  postId: z.string(),
  status: PostStatusSchema,
  cancelled: z.array(NetworkSchema),
  notCancelled: z.array(z.object({ network: NetworkSchema, reason: z.string() })),
});

export const AccountViewSchema = z.object({
  network: NetworkSchema,
  connected: z.boolean(),
  status: AccountStatusSchema,
  handle: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  warnings: z.array(z.string()),
  details: z.record(z.string(), z.unknown()),
  limits: z.object({
    text: z.object({ max: z.number(), unit: z.string(), secondaryMaxBytes: z.number().optional() }),
    images: z.object({ max: z.number(), maxBytes: z.number() }),
    video: z
      .object({ max: z.number(), maxBytes: z.number(), maxDurationMs: z.number() })
      .nullable(),
    threads: z.boolean(),
    notes: z.array(z.string()),
  }),
  connectKind: z.enum(['credentials', 'oauth', 'browser']),
  connectFields: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        secret: z.boolean(),
        placeholder: z.string().optional(),
      }),
    )
    .optional(),
  lastSelfTest: z
    .object({ at: z.number(), ok: z.boolean(), message: z.string().optional() })
    .nullable()
    .optional(),
  canTestPost: z.boolean(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const MediaUploadResultSchema = MediaInfoSchema.extend({
  compatibility: z.record(z.string(), z.object({ ok: z.boolean(), reason: z.string().optional() })),
});
export type MediaUploadResult = z.infer<typeof MediaUploadResultSchema>;

export const NotificationViewSchema = z.object({
  id: z.string(),
  event: z.string(),
  route: z.string(),
  createdAt: z.number().int(),
  deliveredAt: z.number().int().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

/* ------------------------------------------------------------------ */
/* WebSocket events (/ws/events)                                       */
/* ------------------------------------------------------------------ */

export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post.updated'), postId: z.string(), status: PostStatusSchema }),
  z.object({
    type: z.literal('target.updated'),
    postId: z.string(),
    targetId: z.string(),
    network: NetworkSchema,
    status: TargetStatusSchema,
  }),
  z.object({
    type: z.literal('account.updated'),
    network: NetworkSchema,
    status: AccountStatusSchema,
  }),
  z.object({ type: z.literal('notification.updated'), id: z.string(), delivered: z.boolean() }),
  z.object({
    type: z.literal('browser.session'),
    sessionId: z.string(),
    state: z.enum(['started', 'logged_in', 'saved', 'closed', 'error']),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

/* ------------------------------------------------------------------ */
/* Webhook events to Hermes                                            */
/* ------------------------------------------------------------------ */

export const WebhookEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('confirmation_code'),
    draftId: z.string(),
    code: z.string(),
    expiresAt: z.string(),
    summary: z.string(),
    at: z.string(),
  }),
  z.object({
    event: z.literal('published'),
    postId: z.string(),
    network: NetworkSchema,
    url: z.string().nullable(),
    scheduledFor: z.string(),
    at: z.string(),
    summary: z.string(),
  }),
  z.object({
    event: z.literal('failed'),
    postId: z.string(),
    network: NetworkSchema,
    code: z.string(),
    message: z.string(),
    scheduledFor: z.string(),
    at: z.string(),
    summary: z.string(),
    /** True when the agent route should ask the user what to do. */
    needsDecision: z.boolean(),
  }),
  z.object({
    event: z.literal('token_expiring'),
    network: NetworkSchema,
    expiresAt: z.string(),
    at: z.string(),
    summary: z.string(),
  }),
  z.object({
    event: z.literal('session_expired'),
    network: NetworkSchema,
    at: z.string(),
    summary: z.string(),
  }),
  z.object({
    event: z.literal('self_test_failed'),
    network: NetworkSchema,
    message: z.string(),
    at: z.string(),
    summary: z.string(),
  }),
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
