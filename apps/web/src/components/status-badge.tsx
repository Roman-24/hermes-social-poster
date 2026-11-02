import type { AccountConnectionStatus, PostStatus, TargetStatus } from '@poster/core';
import { Badge } from '@/components/ui/badge';

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

const POST: Record<PostStatus, Variant> = {
  draft: 'muted',
  scheduled: 'info',
  queued: 'info',
  publishing: 'warning',
  published: 'success',
  partially_published: 'warning',
  failed: 'danger',
  cancelled: 'muted',
  expired: 'muted',
};

const TARGET: Record<TargetStatus, Variant> = {
  pending: 'info',
  publishing: 'warning',
  retrying: 'warning',
  published: 'success',
  failed: 'danger',
  skipped: 'muted',
  needs_auth: 'danger',
  cancelled: 'muted',
};

const ACCOUNT: Record<AccountConnectionStatus, Variant> = {
  connected: 'success',
  needs_auth: 'danger',
  disconnected: 'muted',
};

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return <Badge variant={POST[status]}>{status.replace('_', ' ')}</Badge>;
}

export function TargetStatusBadge({ status }: { status: TargetStatus }) {
  return <Badge variant={TARGET[status]}>{status.replace('_', ' ')}</Badge>;
}

export function AccountStatusBadge({ status }: { status: AccountConnectionStatus }) {
  const label = status === 'needs_auth' ? 'needs login' : status;
  return <Badge variant={ACCOUNT[status]}>{label}</Badge>;
}
