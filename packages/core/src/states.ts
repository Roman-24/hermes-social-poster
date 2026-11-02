import { z } from 'zod';

export const PostStatusSchema = z.enum([
  'draft',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'cancelled',
  'expired',
]);
export type PostStatus = z.infer<typeof PostStatusSchema>;

export const TargetStatusSchema = z.enum([
  'pending',
  'publishing',
  'retrying',
  'published',
  'failed',
  'skipped',
  'needs_auth',
  'cancelled',
]);
export type TargetStatus = z.infer<typeof TargetStatusSchema>;

export const FINAL_POST_STATUSES: ReadonlySet<PostStatus> = new Set<PostStatus>([
  'published',
  'partially_published',
  'failed',
  'cancelled',
  'expired',
]);

export const FINAL_TARGET_STATUSES: ReadonlySet<TargetStatus> = new Set<TargetStatus>([
  'published',
  'failed',
  'skipped',
  'cancelled',
]);

export const AccountStatusSchema = z.enum(['connected', 'needs_auth', 'disconnected']);
export type AccountConnectionStatus = z.infer<typeof AccountStatusSchema>;

export const ActorSchema = z.enum(['mcp', 'ui', 'api', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Derive the post status from its targets. `needs_auth` counts as terminal here: nothing happens
 * until you log in again and retry, so the post should read as failed / partially published.
 */
export function derivePostStatus(targets: { status: TargetStatus }[]): PostStatus {
  if (targets.length === 0) return 'failed';
  const statuses = targets.map((t) => t.status);
  const terminal = (s: TargetStatus) => FINAL_TARGET_STATUSES.has(s) || s === 'needs_auth';
  const allFinal = statuses.every(terminal);
  if (!allFinal) {
    if (statuses.some((s) => s === 'publishing' || s === 'retrying')) return 'publishing';
    return 'scheduled';
  }
  const published = statuses.filter((s) => s === 'published').length;
  const cancelled = statuses.filter((s) => s === 'cancelled').length;
  if (cancelled === statuses.length) return 'cancelled';
  if (published === statuses.length) return 'published';
  if (published > 0) return 'partially_published';
  return 'failed';
}
