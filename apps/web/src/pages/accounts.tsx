import * as React from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountView, Network } from '@poster/core';
import { NETWORK_LABELS, NETWORKS } from '@/lib/networks';
import { accountsApi, errorMessage, settingsApi } from '@/lib/api';
import { daysUntil, fmtBytes, fmtDuration, fmtLocal } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { AccountStatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorBox, PageHeader } from '@/components/layout';
import { accountsRoute } from '@/router';

const ORDER: Network[] = ['x', 'farcaster', 'linkedin', 'nostr', 'bluesky'];

export function AccountsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const search = useSearch({ from: accountsRoute.id });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
    staleTime: 60_000,
  });

  // OAuth callback outcome arrives via search params.
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (handled.current) return;
    if (search.connected) {
      handled.current = true;
      toast.success(`${NETWORK_LABELS[search.connected as Network] ?? search.connected} connected`);
      void navigate({ to: '/accounts', search: {}, replace: true });
    } else if (search.error) {
      handled.current = true;
      toast.error('Connect failed', search.error);
      void navigate({ to: '/accounts', search: {}, replace: true });
    }
  }, [search.connected, search.error, navigate, toast]);

  const byNetwork = new Map((accounts.data ?? []).map((a) => [a.network, a]));
  const ordered = [...ORDER, ...NETWORKS.filter((n) => !ORDER.includes(n))];

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="One account per network. Secrets are stored encrypted; the UI never shows them again."
      />
      {accounts.isError ? <ErrorBox message={errorMessage(accounts.error)} /> : null}
      {accounts.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
      {accounts.data && accounts.data.length === 0 ? (
        <EmptyState title="No networks reported by the server" />
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {ordered.map((n) => {
          const a = byNetwork.get(n);
          return a ? (
            <AccountCard
              key={n}
              account={a}
              linkedinClientId={settings.data?.linkedinClientId ?? null}
            />
          ) : null;
        })}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  linkedinClientId,
}: {
  account: AccountView;
  linkedinClientId: string | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['accounts'] });

  const connect = useMutation({
    mutationFn: (fields?: Record<string, string>) => accountsApi.connect(account.network, fields),
    onSuccess: (res) => {
      if ('kind' in res && res.kind === 'oauth' && res.url) {
        window.location.assign(res.url);
        return;
      }
      if ('kind' in res && res.kind === 'browser' && res.sessionId) {
        void navigate({
          to: '/accounts/$network/browser/$sessionId',
          params: { network: account.network, sessionId: res.sessionId },
        });
        return;
      }
      invalidate();
      setConnectOpen(false);
      toast.success(`${NETWORK_LABELS[account.network]} connected`);
    },
    onError: (e) => toast.error('Connect failed', errorMessage(e)),
  });

  const disconnect = useMutation({
    mutationFn: () => accountsApi.disconnect(account.network),
    onSuccess: () => {
      invalidate();
      setDisconnectOpen(false);
      toast.success(`${NETWORK_LABELS[account.network]} disconnected`);
    },
    onError: (e) => toast.error('Disconnect failed', errorMessage(e)),
  });

  const testPost = useMutation({
    mutationFn: () => accountsApi.testPost(account.network),
    onSuccess: (r) => toast.success('Test post published', r.url ?? r.remoteIds.join(', ')),
    onError: (e) => toast.error('Test post failed', errorMessage(e)),
  });

  const selfTest = useMutation({
    mutationFn: () => accountsApi.selfTest(account.network),
    onSuccess: (r) => {
      invalidate();
      if (r.ok) toast.success('Self-test passed', r.message);
      else toast.error('Self-test failed', r.message);
    },
    onError: (e) => toast.error('Self-test failed', errorMessage(e)),
  });

  const onConnectClick = () => {
    if (account.connectKind === 'credentials') setConnectOpen(true);
    else connect.mutate(undefined);
  };

  const expiresDays = account.expiresAt ? daysUntil(account.expiresAt) : null;
  const linkedinMissingApp = account.network === 'linkedin' && !linkedinClientId;
  const lim = account.limits;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{NETWORK_LABELS[account.network]}</CardTitle>
          <AccountStatusBadge status={account.status} />
        </div>
        <div className="text-sm text-muted">
          {account.handle ? (
            <span className="font-mono text-fg">{account.handle}</span>
          ) : (
            'Not connected'
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {expiresDays !== null ? (
          <div className={expiresDays < 7 ? 'text-warning' : 'text-muted'}>
            Token{' '}
            {expiresDays < 0
              ? 'expired'
              : `expires in ${expiresDays} day${expiresDays === 1 ? '' : 's'}`}{' '}
            ({fmtLocal(account.expiresAt)})
          </div>
        ) : null}
        {account.warnings.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-warning">
            {account.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : null}
        {linkedinMissingApp ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
            Add your LinkedIn app client id and secret in{' '}
            <Link to="/settings" className="underline">
              Settings
            </Link>{' '}
            first.
          </div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted">
          <dt>Text</dt>
          <dd>
            {lim.text.max.toLocaleString()} {lim.text.unit}
            {lim.text.secondaryMaxBytes
              ? ` / ${lim.text.secondaryMaxBytes.toLocaleString()} bytes`
              : ''}
          </dd>
          <dt>Images</dt>
          <dd>
            {lim.images.max > 0
              ? `up to ${lim.images.max}, ${fmtBytes(lim.images.maxBytes)} each`
              : 'no'}
          </dd>
          <dt>Video</dt>
          <dd>
            {lim.video
              ? `1, ${fmtBytes(lim.video.maxBytes)}, ${fmtDuration(lim.video.maxDurationMs)}`
              : 'no'}
          </dd>
          <dt>Threads</dt>
          <dd>{lim.threads ? 'yes' : 'no'}</dd>
        </dl>
        {lim.notes.length ? <p className="text-xs text-muted">{lim.notes.join(' ')}</p> : null}
        {account.lastSelfTest ? (
          <div className={account.lastSelfTest.ok ? 'text-xs text-muted' : 'text-xs text-danger'}>
            Last self-test {account.lastSelfTest.ok ? 'passed' : 'failed'} ·{' '}
            {fmtLocal(account.lastSelfTest.at)}
            {account.lastSelfTest.message ? ` · ${account.lastSelfTest.message}` : ''}
          </div>
        ) : null}
        {Object.keys(account.details).length ? (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Details</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">
              {JSON.stringify(account.details, null, 2)}
            </pre>
          </details>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button
          size="sm"
          onClick={onConnectClick}
          disabled={connect.isPending || (linkedinMissingApp && !account.connected)}
        >
          {connect.isPending
            ? 'Starting…'
            : account.connected || account.status === 'needs_auth'
              ? 'Reconnect'
              : 'Connect'}
        </Button>
        {account.connected && account.canTestPost ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => testPost.mutate()}
            disabled={testPost.isPending}
          >
            {testPost.isPending ? 'Posting…' : 'Test post to self'}
          </Button>
        ) : null}
        {account.connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => selfTest.mutate()}
            disabled={selfTest.isPending}
          >
            {selfTest.isPending ? 'Testing…' : 'Run self-test'}
          </Button>
        ) : null}
        {account.status !== 'disconnected' ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => setDisconnectOpen(true)}
          >
            Disconnect
          </Button>
        ) : null}
      </CardFooter>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={`Disconnect ${NETWORK_LABELS[account.network]}?`}
        description="Stored secrets (and the browser profile, if any) are wiped. Scheduled posts for this network will fail until you reconnect."
        confirmLabel="Disconnect"
        danger
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />

      {account.connectKind === 'credentials' ? (
        <CredentialsDialog
          account={account}
          open={connectOpen}
          onOpenChange={setConnectOpen}
          busy={connect.isPending}
          onSubmit={(fields) => connect.mutate(fields)}
        />
      ) : null}
    </Card>
  );
}

function CredentialsDialog({
  account,
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  account: AccountView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  onSubmit: (fields: Record<string, string>) => void;
}) {
  const fields = account.connectFields ?? [];
  const [values, setValues] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) setValues({});
  }, [open]);
  const complete = fields.every((f) => (values[f.name] ?? '').trim().length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Connect ${NETWORK_LABELS[account.network]}`}
        description={
          account.network === 'nostr'
            ? 'Paste your nsec (or hex key) once. It is encrypted immediately; only the npub is shown afterwards.'
            : account.network === 'bluesky'
              ? 'Use an app password from Bluesky Settings → App passwords, never your main password.'
              : undefined
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (complete) onSubmit(values);
          }}
        >
          {fields.map((f) => (
            <Field key={f.name} label={f.label} htmlFor={`cf-${f.name}`}>
              <Input
                id={`cf-${f.name}`}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={f.placeholder}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            </Field>
          ))}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !complete}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
