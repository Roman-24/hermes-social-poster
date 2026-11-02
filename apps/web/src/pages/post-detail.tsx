import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { TargetView } from '@poster/core';
import { NETWORK_LABELS } from '@/lib/networks';
import { errorMessage, mediaApi, postsApi } from '@/lib/api';
import { fmtBytes, fmtLocal, fmtUtc } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PostStatusBadge, TargetStatusBadge } from '@/components/status-badge';
import { PostActions } from '@/components/post-actions';
import { ErrorBox, PageHeader } from '@/components/layout';
import { postDetailRoute } from '@/router';

export function PostDetailPage() {
  const { postId } = useParams({ from: postDetailRoute.id });
  const post = useQuery({ queryKey: ['post', postId], queryFn: () => postsApi.get(postId) });

  if (post.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (post.isError || !post.data) return <ErrorBox message={errorMessage(post.error)} />;
  const p = post.data;

  return (
    <div>
      <PageHeader
        title={p.schedule.display}
        description={`${p.schedule.isoUtc} · created ${fmtLocal(p.createdAt)}${p.confirmedAt ? ` · confirmed ${fmtLocal(p.confirmedAt)}` : ''} · source ${p.source}`}
        actions={
          <div className="flex items-center gap-2">
            <PostStatusBadge status={p.status} />
            <Badge variant="muted">thread: {p.threadMode}</Badge>
          </div>
        }
      />
      <div className="mb-4">
        <PostActions post={p} />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Base text</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{p.baseText}</pre>
          {p.media.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {p.media.map((m) => (
                <figure key={m.id} className="w-28">
                  <img
                    src={mediaApi.previewUrl(m.id)}
                    alt={m.altText ?? ''}
                    className="h-20 w-28 rounded border border-border object-cover"
                    loading="lazy"
                  />
                  <figcaption className="mt-1 truncate text-xs text-muted">
                    {m.kind} · {fmtBytes(m.bytes)}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {p.targets.map((t) => (
          <TargetCard key={t.id} target={t} postId={p.id} />
        ))}
      </div>
      <div className="mt-6">
        <Link to="/history" className="text-sm text-muted hover:underline">
          ← Back to history
        </Link>
      </div>
    </div>
  );
}

function TargetCard({ target: t, postId }: { target: TargetView; postId: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {NETWORK_LABELS[t.network]} <TargetStatusBadge status={t.status} />
          </CardTitle>
          <div className="text-xs text-muted">
            {t.schedule.display} · {t.schedule.isoUtc}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {t.publishedUrl ? (
          <a
            href={t.publishedUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-primary hover:underline break-all"
          >
            {t.publishedUrl} <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        ) : null}
        {t.lastErrorCode ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-danger">
            <span className="font-mono text-xs">{t.lastErrorCode}</span>
            {t.lastErrorMessage ? <span> · {t.lastErrorMessage}</span> : null}
          </div>
        ) : null}
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted">
          <dt>Attempts</dt>
          <dd>
            {t.attempts}
            {t.nextAttemptAt ? ` · next ${fmtLocal(t.nextAttemptAt)}` : ''}
          </dd>
          {t.remoteIds.length ? (
            <>
              <dt>Remote ids</dt>
              <dd className="font-mono text-xs break-all">{t.remoteIds.join(', ')}</dd>
            </>
          ) : null}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">
            {t.parts.length > 1 ? `Thread (${t.parts.length} parts)` : 'Text'}
          </div>
          <ol className="flex flex-col gap-2">
            {t.parts.map((part, i) => (
              <li key={i} className="rounded-md border border-border bg-accent/40 p-2">
                {t.parts.length > 1 ? (
                  <span className="mr-2 text-xs text-muted">{i + 1}.</span>
                ) : null}
                <span className="whitespace-pre-wrap break-words">{part}</span>
              </li>
            ))}
          </ol>
        </div>
        {t.attemptLog && t.attemptLog.length ? (
          <div>
            <div className="mb-1 text-xs font-medium text-muted">Attempt log</div>
            <Table>
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Finished</TH>
                  <TH>Outcome</TH>
                  <TH>Error</TH>
                  <TH>Debug</TH>
                </TR>
              </THead>
              <TBody>
                {t.attemptLog.map((a) => (
                  <TR key={a.id}>
                    <TD className="whitespace-nowrap">{fmtUtc(a.startedAt)}</TD>
                    <TD className="whitespace-nowrap">
                      {a.finishedAt ? fmtUtc(a.finishedAt) : '—'}
                    </TD>
                    <TD>{a.outcome}</TD>
                    <TD>
                      {a.errorCode ? <span className="font-mono text-xs">{a.errorCode}</span> : '—'}
                      {a.errorMessage ? (
                        <div className="text-xs text-muted">{a.errorMessage}</div>
                      ) : null}
                    </TD>
                    <TD>
                      {a.screenshot ? (
                        <a
                          href={postsApi.screenshotUrl(postId, a.id)}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-primary hover:underline"
                        >
                          screenshot
                        </a>
                      ) : (
                        '—'
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
