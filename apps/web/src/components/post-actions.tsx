import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Network, PostView } from '@poster/core';
import { NETWORK_LABELS } from '@/lib/networks';
import { errorMessage, postsApi, settingsApi } from '@/lib/api';
import { defaultLocalDateTime, timeZones } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

const OPEN_TARGET = new Set(['pending', 'retrying', 'needs_auth', 'publishing']);

function NetworkPicker({
  post,
  selected,
  onChange,
  filter,
}: {
  post: PostView;
  selected: Network[];
  onChange: (n: Network[]) => void;
  filter?: (status: string) => boolean;
}) {
  const options = post.targets.filter((t) => (filter ? filter(t.status) : true));
  if (options.length <= 1) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-medium">Networks</div>
      <div className="flex flex-wrap gap-3">
        {options.map((t) => {
          const checked = selected.length === 0 || selected.includes(t.network);
          return (
            <label key={t.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  const all = options.map((o) => o.network);
                  const current = selected.length === 0 ? all : selected;
                  const next = e.target.checked
                    ? [...new Set([...current, t.network])]
                    : current.filter((n) => n !== t.network);
                  onChange(next.length === all.length ? [] : next);
                }}
              />
              {NETWORK_LABELS[t.network]}{' '}
              <span className="text-xs text-muted">({t.status.replace('_', ' ')})</span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted">Leave all checked to apply to every network.</p>
    </div>
  );
}

export function usePostMutations(postId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['posts'] });
    void qc.invalidateQueries({ queryKey: ['post', postId] });
  };
  const onError = (err: unknown) => toast.error('Action failed', errorMessage(err));

  const cancel = useMutation({
    mutationFn: (networks?: Network[]) => postsApi.cancel(postId, networks),
    onSuccess: (res) => {
      invalidate();
      if (res.notCancelled.length) {
        toast.info(
          `Cancelled ${res.cancelled.length} target${res.cancelled.length === 1 ? '' : 's'}`,
          res.notCancelled.map((n) => `${NETWORK_LABELS[n.network]}: ${n.reason}`).join('; '),
        );
      } else toast.success('Cancelled');
    },
    onError,
  });
  const retry = useMutation({
    mutationFn: (networks?: Network[]) => postsApi.retry(postId, networks),
    onSuccess: () => {
      invalidate();
      toast.success('Retry queued');
    },
    onError,
  });
  const postNow = useMutation({
    mutationFn: (networks?: Network[]) => postsApi.postNow(postId, networks),
    onSuccess: () => {
      invalidate();
      toast.success('Queued for publishing now');
    },
    onError,
  });
  const reschedule = useMutation({
    mutationFn: (args: { at: string; tz: string; networks?: Network[] }) =>
      postsApi.reschedule(postId, { at: args.at, tz: args.tz }, args.networks),
    onSuccess: () => {
      invalidate();
      toast.success('Rescheduled');
    },
    onError,
  });
  return { cancel, retry, postNow, reschedule };
}

export function CancelDialog({
  post,
  open,
  onOpenChange,
}: {
  post: PostView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { cancel } = usePostMutations(post.id);
  const [networks, setNetworks] = React.useState<Network[]>([]);
  React.useEffect(() => {
    if (open) setNetworks([]);
  }, [open]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel post"
      description="Only targets that are not yet publishing can be cancelled."
      confirmLabel="Cancel post"
      danger
      busy={cancel.isPending}
      onConfirm={() =>
        cancel.mutate(networks.length ? networks : undefined, {
          onSuccess: () => onOpenChange(false),
        })
      }
    >
      <NetworkPicker
        post={post}
        selected={networks}
        onChange={setNetworks}
        filter={(s) => OPEN_TARGET.has(s) || s === 'pending'}
      />
    </ConfirmDialog>
  );
}

export function PostNowDialog({
  post,
  open,
  onOpenChange,
}: {
  post: PostView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { postNow } = usePostMutations(post.id);
  const [networks, setNetworks] = React.useState<Network[]>([]);
  React.useEffect(() => {
    if (open) setNetworks([]);
  }, [open]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Post now"
      description="Publishes the selected targets immediately instead of at the scheduled time."
      confirmLabel="Post now"
      busy={postNow.isPending}
      onConfirm={() =>
        postNow.mutate(networks.length ? networks : undefined, {
          onSuccess: () => onOpenChange(false),
        })
      }
    >
      <NetworkPicker
        post={post}
        selected={networks}
        onChange={setNetworks}
        filter={(s) => s !== 'published' && s !== 'publishing' && s !== 'cancelled'}
      />
    </ConfirmDialog>
  );
}

export function RescheduleDialog({
  post,
  open,
  onOpenChange,
}: {
  post: PostView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { reschedule } = usePostMutations(post.id);
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
    staleTime: 60_000,
  });
  const defaultTz = post.schedule.tz || settings.data?.defaultTz || 'Europe/Prague';
  const [tz, setTz] = React.useState(defaultTz);
  const [at, setAt] = React.useState(() => defaultLocalDateTime(defaultTz));
  const [networks, setNetworks] = React.useState<Network[]>([]);
  const zones = React.useMemo(() => timeZones(), []);

  React.useEffect(() => {
    if (open) {
      setTz(defaultTz);
      setAt(defaultLocalDateTime(defaultTz));
      setNetworks([]);
    }
  }, [open, defaultTz]);

  const submit = () => {
    // datetime-local gives "YYYY-MM-DDTHH:mm"; the API wants "YYYY-MM-DD HH:mm".
    const local = at.replace('T', ' ').slice(0, 16);
    reschedule.mutate(
      { at: local, tz, networks: networks.length ? networks : undefined },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Reschedule"
        description="Pick a local time and the IANA zone it belongs to. The server stores the UTC instant."
      >
        <div className="flex flex-col gap-3">
          <Field label="Local date and time" htmlFor="rs-at">
            <Input
              id="rs-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field
            label="Time zone"
            htmlFor="rs-tz"
            hint="IANA name, e.g. Europe/Prague or America/New_York"
          >
            <Input id="rs-tz" list="tz-list" value={tz} onChange={(e) => setTz(e.target.value)} />
            <datalist id="tz-list">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
          <NetworkPicker
            post={post}
            selected={networks}
            onChange={setNetworks}
            filter={(s) => OPEN_TARGET.has(s) || s === 'failed'}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={reschedule.isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={reschedule.isPending || !at || !tz}>
            {reschedule.isPending ? 'Saving…' : 'Reschedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Row of action buttons with their dialogs, shared by Queue and Post detail. */
export function PostActions({ post, compact = false }: { post: PostView; compact?: boolean }) {
  const [dlg, setDlg] = React.useState<'cancel' | 'reschedule' | 'now' | null>(null);
  const { retry } = usePostMutations(post.id);
  const hasOpen = post.targets.some((t) => OPEN_TARGET.has(t.status));
  const hasFailed = post.targets.some((t) => t.status === 'failed' || t.status === 'needs_auth');
  const canSchedule =
    post.status === 'scheduled' ||
    post.status === 'queued' ||
    post.status === 'draft' ||
    hasOpen ||
    hasFailed;
  const size = compact ? 'sm' : 'default';
  return (
    <div className="flex flex-wrap gap-2">
      {hasFailed ? (
        <Button
          size={size}
          variant="secondary"
          onClick={() => retry.mutate(undefined)}
          disabled={retry.isPending}
        >
          Retry failed
        </Button>
      ) : null}
      {canSchedule ? (
        <>
          <Button size={size} variant="secondary" onClick={() => setDlg('now')}>
            Post now
          </Button>
          <Button size={size} variant="outline" onClick={() => setDlg('reschedule')}>
            Reschedule
          </Button>
        </>
      ) : null}
      {hasOpen || post.status === 'draft' ? (
        <Button
          size={size}
          variant="outline"
          className="text-danger"
          onClick={() => setDlg('cancel')}
        >
          Cancel
        </Button>
      ) : null}
      <CancelDialog
        post={post}
        open={dlg === 'cancel'}
        onOpenChange={(o) => setDlg(o ? 'cancel' : null)}
      />
      <RescheduleDialog
        post={post}
        open={dlg === 'reschedule'}
        onOpenChange={(o) => setDlg(o ? 'reschedule' : null)}
      />
      <PostNowDialog
        post={post}
        open={dlg === 'now'}
        onOpenChange={(o) => setDlg(o ? 'now' : null)}
      />
    </div>
  );
}
