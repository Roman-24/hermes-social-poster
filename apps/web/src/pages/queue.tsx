import { useQuery } from '@tanstack/react-query';
import type { PostStatus } from '@poster/core';
import { errorMessage, postsApi } from '@/lib/api';
import { EmptyState, ErrorBox, PageHeader } from '@/components/layout';
import { PostRow } from '@/components/post-row';

const OPEN: PostStatus[] = ['scheduled', 'queued', 'publishing', 'draft'];

export function QueuePage() {
  const posts = useQuery({
    queryKey: ['posts', 'queue'],
    queryFn: () => postsApi.list({ status: OPEN, limit: 200 }),
    refetchInterval: 30_000,
  });

  const items = [...(posts.data?.items ?? [])].sort(
    (a, b) => a.schedule.atUtcMs - b.schedule.atUtcMs,
  );

  return (
    <div>
      <PageHeader
        title="Queue"
        description="Upcoming posts in their own time zone and UTC. Drafts wait for your confirmation code in SimpleX."
      />
      {posts.isError ? <ErrorBox message={errorMessage(posts.error)} /> : null}
      {posts.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
      {posts.data && items.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          description="New drafts from Hermes will show up here."
        />
      ) : null}
      <div className="flex flex-col gap-3">
        {items.map((p) => (
          <PostRow key={p.id} post={p} showActions />
        ))}
      </div>
    </div>
  );
}
