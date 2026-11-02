import { Link } from '@tanstack/react-router';
import { Image as ImageIcon, Video } from 'lucide-react';
import type { PostView } from '@poster/core';
import { NETWORK_LABELS } from '@/lib/networks';
import { excerpt } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PostStatusBadge, TargetStatusBadge } from '@/components/status-badge';
import { PostActions } from '@/components/post-actions';

export function PostRow({ post, showActions }: { post: PostView; showActions: boolean }) {
  const images = post.media.filter((m) => m.kind === 'image').length;
  const videos = post.media.filter((m) => m.kind === 'video').length;
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/posts/$postId"
              params={{ postId: post.id }}
              className="font-medium hover:underline"
            >
              {post.schedule.display}
            </Link>
            <span className="text-xs text-muted">{post.schedule.isoUtc}</span>
            <PostStatusBadge status={post.status} />
            {post.source !== 'mcp' ? <Badge variant="muted">{post.source}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted break-words">{excerpt(post.baseText, 180)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {post.targets.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
              >
                {NETWORK_LABELS[t.network]}
                <TargetStatusBadge status={t.status} />
                {t.schedule.atUtcMs !== post.schedule.atUtcMs ? (
                  <span className="text-muted">{t.schedule.display}</span>
                ) : null}
              </span>
            ))}
            {images ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <ImageIcon className="h-3.5 w-3.5" /> {images}
              </span>
            ) : null}
            {videos ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <Video className="h-3.5 w-3.5" /> {videos}
              </span>
            ) : null}
          </div>
        </div>
        {showActions ? (
          <div className="shrink-0">
            <PostActions post={post} compact />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
