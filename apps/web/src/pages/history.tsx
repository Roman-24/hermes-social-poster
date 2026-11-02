import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PostStatus } from '@poster/core';
import { errorMessage, postsApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/tabs';
import { EmptyState, ErrorBox, PageHeader } from '@/components/layout';
import { PostRow } from '@/components/post-row';

const ALL: PostStatus[] = ['published', 'partially_published', 'failed', 'cancelled', 'expired'];
type Filter = 'all' | 'published' | 'partially_published' | 'failed' | 'cancelled';

export function HistoryPage() {
  const [filter, setFilter] = React.useState<Filter>('all');
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const statuses: PostStatus[] =
    filter === 'all' ? ALL : filter === 'cancelled' ? ['cancelled', 'expired'] : [filter];

  const posts = useQuery({
    queryKey: ['posts', 'history', statuses, cursor ?? ''],
    queryFn: () => postsApi.list({ status: statuses, limit: 50, cursor }),
  });

  const items = [...(posts.data?.items ?? [])].sort(
    (a, b) => b.schedule.atUtcMs - a.schedule.atUtcMs,
  );

  return (
    <div>
      <PageHeader
        title="History"
        description="Published and failed posts with links to the live posts and the attempt log."
        actions={
          <Tabs
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setCursor(undefined);
            }}
            items={[
              { value: 'all', label: 'All' },
              { value: 'published', label: 'Published' },
              { value: 'partially_published', label: 'Partial' },
              { value: 'failed', label: 'Failed' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
        }
      />
      {posts.isError ? <ErrorBox message={errorMessage(posts.error)} /> : null}
      {posts.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
      {posts.data && items.length === 0 ? <EmptyState title="No posts yet" /> : null}
      <div className="flex flex-col gap-3">
        {items.map((p) => (
          <PostRow
            key={p.id}
            post={p}
            showActions={p.status === 'partially_published' || p.status === 'failed'}
          />
        ))}
      </div>
      {posts.data?.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => setCursor(posts.data?.nextCursor ?? undefined)}>
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  );
}
