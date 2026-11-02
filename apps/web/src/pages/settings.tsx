import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import type { Settings } from '@poster/core';
import {
  authApi,
  errorMessage,
  getMe,
  notificationsApi,
  settingsApi,
  systemApi,
  type SettingsUpdate,
  type SettingsView,
} from '@/lib/api';
import { fmtLocal, fmtRelative, timeZones } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { ErrorBox, PageHeader } from '@/components/layout';

type Form = Settings & {
  hermesWebhookSecret: string;
  linkedinClientId: string;
  linkedinClientSecret: string;
};

function toForm(v: SettingsView): Form {
  const { secretsSet: _s, linkedinClientId, effectiveLimits: _e, ...settings } = v;
  return {
    ...settings,
    hermesWebhookSecret: '',
    linkedinClientId: linkedinClientId ?? '',
    linkedinClientSecret: '',
  };
}

function toPatch(f: Form, original: SettingsView): SettingsUpdate {
  const { hermesWebhookSecret, linkedinClientId, linkedinClientSecret, ...settings } = f;
  const patch: SettingsUpdate = { ...settings };
  const secrets: NonNullable<SettingsUpdate['secrets']> = {};
  if (hermesWebhookSecret) secrets.hermesWebhookSecret = hermesWebhookSecret;
  if (linkedinClientSecret) secrets.linkedinClientSecret = linkedinClientSecret;
  if (linkedinClientId !== (original.linkedinClientId ?? ''))
    secrets.linkedinClientId = linkedinClientId;
  if (Object.keys(secrets).length) patch.secrets = secrets;
  return patch;
}

const lines = (arr: string[]) => arr.join('\n');
const parseLines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const [form, setForm] = React.useState<Form | null>(null);
  const zones = React.useMemo(() => timeZones(), []);

  React.useEffect(() => {
    if (settings.data && !form) setForm(toForm(settings.data));
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (patch: SettingsUpdate) => settingsApi.update(patch),
    onSuccess: (v) => {
      qc.setQueryData(['settings'], v);
      setForm(toForm(v));
      toast.success('Settings saved');
    },
    onError: (e) => toast.error('Save failed', errorMessage(e)),
  });

  const webhookTest = useMutation({
    mutationFn: settingsApi.webhookTest,
    onSuccess: (r) =>
      r.ok
        ? toast.success('Webhook reached Hermes', r.status ? `HTTP ${r.status}` : undefined)
        : toast.error('Webhook test failed', r.error ?? `HTTP ${r.status ?? '?'}`),
    onError: (e) => toast.error('Webhook test failed', errorMessage(e)),
  });

  if (settings.isError) return <ErrorBox message={errorMessage(settings.error)} />;
  if (!form || !settings.data) return <p className="text-sm text-muted">Loading…</p>;
  const f = form;
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((cur) => (cur ? { ...cur, [key]: value } : cur));
  const secretsSet = settings.data.secretsSet;

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Changes apply after Save. Secrets are write-only: once saved they are never shown again."
        actions={
          <Button onClick={() => save.mutate(toPatch(f, settings.data!))} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Default time zone"
              htmlFor="tz"
              hint="IANA zone used when a schedule has no zone."
              className="sm:col-span-2"
            >
              <Input
                id="tz"
                list="tz-all"
                value={f.defaultTz}
                onChange={(e) => set('defaultTz', e.target.value)}
              />
              <datalist id="tz-all">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label="Max posts per day" htmlFor="mpd">
              <Input
                id="mpd"
                type="number"
                min={1}
                max={100}
                value={f.maxPostsPerDay}
                onChange={(e) => set('maxPostsPerDay', num(e.target.value, 3))}
              />
            </Field>
            <Field label="Code TTL (minutes)" htmlFor="ttl">
              <Input
                id="ttl"
                type="number"
                min={1}
                max={240}
                value={f.codeTtlMinutes}
                onChange={(e) => set('codeTtlMinutes', num(e.target.value, 30))}
              />
            </Field>
            <Field label="Draft expiry (hours)" htmlFor="dex">
              <Input
                id="dex"
                type="number"
                min={1}
                value={f.draftExpiryHours}
                onChange={(e) => set('draftExpiryHours', num(e.target.value, 24))}
              />
            </Field>
            <Field
              label="Missed window (minutes)"
              htmlFor="mw"
              hint="Later than this after downtime → MISSED_WINDOW, you are asked."
            >
              <Input
                id="mw"
                type="number"
                min={1}
                value={f.missedWindowMinutes}
                onChange={(e) => set('missedWindowMinutes', num(e.target.value, 30))}
              />
            </Field>
            <Field label="Min gap per network (minutes)" htmlFor="gap">
              <Input
                id="gap"
                type="number"
                min={0}
                value={f.minGapPerNetworkMinutes}
                onChange={(e) => set('minGapPerNetworkMinutes', num(e.target.value, 1))}
              />
            </Field>
            <Field
              label="Retention (days)"
              htmlFor="ret"
              hint="Media and debug screenshots are deleted this long after a post is final."
            >
              <Input
                id="ret"
                type="number"
                min={1}
                value={f.retentionDays}
                onChange={(e) => set('retentionDays', num(e.target.value, 30))}
              />
            </Field>
            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              <div>
                <div className="text-sm font-medium">Thread markers</div>
                <div className="text-xs text-muted">
                  Append (1/n) to each part of an auto-split thread.
                </div>
              </div>
              <Switch
                checked={f.threadMarker.enabled}
                onCheckedChange={(v) => set('threadMarker', { ...f.threadMarker, enabled: v })}
                aria-label="Thread markers"
              />
            </div>
            <Field label="Marker format" htmlFor="mf" hint="Use {i} and {n}.">
              <Input
                id="mf"
                value={f.threadMarker.format}
                onChange={(e) => set('threadMarker', { ...f.threadMarker, format: e.target.value })}
              />
            </Field>
            <Field label="Retry attempts" htmlFor="ra">
              <Input
                id="ra"
                type="number"
                min={1}
                max={10}
                value={f.retry.maxAttempts}
                onChange={(e) => set('retry', { ...f.retry, maxAttempts: num(e.target.value, 3) })}
              />
            </Field>
            <Field
              label="Backoff (minutes, comma-separated)"
              htmlFor="bo"
              className="sm:col-span-2"
            >
              <Input
                id="bo"
                value={f.retry.backoffMinutes.join(', ')}
                onChange={(e) =>
                  set('retry', {
                    ...f.retry,
                    backoffMinutes: e.target.value
                      .split(',')
                      .map((x) => Number(x.trim()))
                      .filter((x) => Number.isFinite(x) && x >= 0),
                  })
                }
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Nostr and Blossom</CardTitle>
            <CardDescription>
              Relays receive your notes; Blossom servers host media (publicly).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field label="Relays (one per line)" htmlFor="relays">
              <Textarea
                id="relays"
                rows={5}
                value={lines(f.nostr.relays)}
                onChange={(e) => set('nostr', { ...f.nostr, relays: parseLines(e.target.value) })}
                placeholder="wss://relay.example"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Min relays OK" htmlFor="minr">
                <Input
                  id="minr"
                  type="number"
                  min={1}
                  value={f.nostr.minRelays}
                  onChange={(e) => set('nostr', { ...f.nostr, minRelays: num(e.target.value, 2) })}
                />
              </Field>
              <Field label="Soft text cap" htmlFor="soft">
                <Input
                  id="soft"
                  type="number"
                  min={100}
                  value={f.nostr.softTextMax}
                  onChange={(e) =>
                    set('nostr', { ...f.nostr, softTextMax: num(e.target.value, 5000) })
                  }
                />
              </Field>
            </div>
            <Field label="Blossom primary" htmlFor="bp">
              <Input
                id="bp"
                value={f.blossom.primary}
                onChange={(e) => set('blossom', { ...f.blossom, primary: e.target.value })}
              />
            </Field>
            <Field label="Blossom mirrors (one per line)" htmlFor="bm">
              <Textarea
                id="bm"
                rows={3}
                value={lines(f.blossom.mirrors)}
                onChange={(e) =>
                  set('blossom', { ...f.blossom, mirrors: parseLines(e.target.value) })
                }
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Hermes webhook</CardTitle>
            <CardDescription>
              Results and confirmation codes are POSTed here, signed with HMAC-SHA256.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field
              label="Webhook base URL"
              htmlFor="wh"
              hint="e.g. http://host.containers.internal:8644"
            >
              <Input
                id="wh"
                value={f.hermes.webhookBaseUrl ?? ''}
                onChange={(e) =>
                  set('hermes', { ...f.hermes, webhookBaseUrl: e.target.value.trim() || null })
                }
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Direct route (deliver_only)" htmlFor="dr">
                <Input
                  id="dr"
                  value={f.hermes.directRoute}
                  onChange={(e) => set('hermes', { ...f.hermes, directRoute: e.target.value })}
                />
              </Field>
              <Field label="Agent route (optional)" htmlFor="ar">
                <Input
                  id="ar"
                  value={f.hermes.agentRoute ?? ''}
                  onChange={(e) =>
                    set('hermes', { ...f.hermes, agentRoute: e.target.value.trim() || null })
                  }
                />
              </Field>
              <Field label="Signature header" htmlFor="sh">
                <Input
                  id="sh"
                  value={f.hermes.signatureHeader}
                  onChange={(e) => set('hermes', { ...f.hermes, signatureHeader: e.target.value })}
                />
              </Field>
              <Field label="Signature prefix" htmlFor="sp">
                <Input
                  id="sp"
                  value={f.hermes.signaturePrefix}
                  onChange={(e) => set('hermes', { ...f.hermes, signaturePrefix: e.target.value })}
                />
              </Field>
            </div>
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  Webhook secret{' '}
                  {secretsSet.hermesWebhookSecret ? (
                    <Badge variant="success">set</Badge>
                  ) : (
                    <Badge variant="warning">not set</Badge>
                  )}
                </span>
              }
              htmlFor="ws"
              hint="Must equal WEBHOOK_SECRET in Hermes. Leave empty to keep the current one."
            >
              <Input
                id="ws"
                type="password"
                autoComplete="off"
                value={f.hermesWebhookSecret}
                onChange={(e) => set('hermesWebhookSecret', e.target.value)}
              />
            </Field>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => webhookTest.mutate()}
                disabled={webhookTest.isPending}
              >
                {webhookTest.isPending ? 'Sending…' : 'Send test'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>LinkedIn app and X</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field label="LinkedIn client id" htmlFor="lcid">
              <Input
                id="lcid"
                value={f.linkedinClientId}
                onChange={(e) => set('linkedinClientId', e.target.value)}
              />
            </Field>
            <Field
              label={
                <span className="inline-flex items-center gap-2">
                  LinkedIn client secret{' '}
                  {secretsSet.linkedinClientSecret ? (
                    <Badge variant="success">set</Badge>
                  ) : (
                    <Badge variant="warning">not set</Badge>
                  )}
                </span>
              }
              htmlFor="lcs"
              hint="Register the callback https://<your tailnet host>/api/v1/accounts/linkedin/callback in the LinkedIn app."
            >
              <Input
                id="lcs"
                type="password"
                autoComplete="off"
                value={f.linkedinClientSecret}
                onChange={(e) => set('linkedinClientSecret', e.target.value)}
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">X composer fallback</div>
                <div className="text-xs text-muted">
                  Post through the x.com composer in Chromium when Rettiwt fails with a non-auth
                  error.
                </div>
              </div>
              <Switch
                checked={f.x.composerFallback}
                onCheckedChange={(v) => set('x', { ...f.x, composerFallback: v })}
                aria-label="X composer fallback"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Network, self-test and browser</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field
              label="Allowed Host headers (one per line)"
              htmlFor="hosts"
              hint="127.0.0.1:8787 is always allowed. Add your ts.net name, e.g. poster.tailnet.ts.net."
            >
              <Textarea
                id="hosts"
                rows={3}
                value={lines(f.allowedHosts)}
                onChange={(e) => set('allowedHosts', parseLines(e.target.value))}
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Nightly selector self-test</div>
                <div className="text-xs text-muted">
                  Opens the X and Farcaster composers read-only and checks every selector.
                </div>
              </div>
              <Switch
                checked={f.selfTest.enabled}
                onCheckedChange={(v) => set('selfTest', { ...f.selfTest, enabled: v })}
                aria-label="Self-test"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Self-test hour (0–23)" htmlFor="sth">
                <Input
                  id="sth"
                  type="number"
                  min={0}
                  max={23}
                  value={f.selfTest.hour}
                  onChange={(e) => set('selfTest', { ...f.selfTest, hour: num(e.target.value, 4) })}
                />
              </Field>
              <Field label="Remote session idle (minutes)" htmlFor="idle">
                <Input
                  id="idle"
                  type="number"
                  min={1}
                  max={60}
                  value={f.browser.remoteSessionIdleMinutes}
                  onChange={(e) =>
                    set('browser', {
                      ...f.browser,
                      remoteSessionIdleMinutes: num(e.target.value, 10),
                    })
                  }
                />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Keep debug screenshots</div>
                <div className="text-xs text-muted">
                  Stored on failed browser attempts, deleted with retention.
                </div>
              </div>
              <Switch
                checked={f.browser.keepDebugScreenshots}
                onCheckedChange={(v) => set('browser', { ...f.browser, keepDebugScreenshots: v })}
                aria-label="Keep screenshots"
              />
            </div>
          </CardContent>
        </Card>

        <TokensCard mcpSet={secretsSet.mcpToken} apiSet={secretsSet.apiToken} />
        <SecurityCard />
        <SystemCard />
        <NotificationsCard />
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={() => save.mutate(toPatch(f, settings.data!))} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function TokensCard({ mcpSet, apiSet }: { mcpSet: boolean; apiSet: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [shown, setShown] = React.useState<{ kind: 'mcp' | 'api'; token: string } | null>(null);
  const [apiScope, setApiScope] = React.useState<'read' | 'write'>('read');
  const rotate = useMutation({
    mutationFn: (args: { kind: 'mcp' | 'api'; scope?: 'read' | 'write' }) =>
      settingsApi.rotateToken(args.kind, args.scope),
    onSuccess: (r, args) => {
      setShown({ kind: args.kind, token: r.token });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast.error('Rotation failed', errorMessage(e)),
  });
  const snippet = shown
    ? shown.kind === 'mcp'
      ? `# ~/.hermes/config.yaml\nmcp_servers:\n  social_poster:\n    url: "http://127.0.0.1:8787/mcp"\n    headers:\n      Authorization: "Bearer ${shown.token}"`
      : `curl -H "Authorization: Bearer ${shown.token}" http://127.0.0.1:8787/api/v1/posts`
    : '';
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed', 'Select the text and copy it manually.');
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tokens</CardTitle>
        <CardDescription>
          Rotating replaces the current token immediately. The new value is shown once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-sm">
            MCP token (Hermes){' '}
            {mcpSet ? (
              <Badge variant="success">set</Badge>
            ) : (
              <Badge variant="warning">not set</Badge>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rotate.mutate({ kind: 'mcp' })}
            disabled={rotate.isPending}
          >
            Rotate MCP token
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-sm">
            API token (scripts){' '}
            {apiSet ? <Badge variant="success">set</Badge> : <Badge variant="muted">not set</Badge>}
            <select
              className="h-8 rounded-md border border-border bg-input px-2 text-xs"
              value={apiScope}
              onChange={(e) => setApiScope(e.target.value as 'read' | 'write')}
              aria-label="API token scope"
            >
              <option value="read">read-only</option>
              <option value="write">read + write</option>
            </select>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => rotate.mutate({ kind: 'api', scope: apiScope })}
            disabled={rotate.isPending}
          >
            Rotate API token
          </Button>
        </div>
      </CardContent>
      <Dialog open={!!shown} onOpenChange={(o) => !o && setShown(null)}>
        <DialogContent
          title={shown?.kind === 'mcp' ? 'New MCP token' : 'New API token'}
          description="Copy it now. It cannot be retrieved later."
        >
          {shown ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={shown.token}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => copy(shown.token)}
                  aria-label="Copy token"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted">
                  {shown.kind === 'mcp' ? 'Hermes config snippet' : 'Example'}
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-accent p-2 text-xs">
                  {snippet}
                </pre>
                <Button size="sm" variant="ghost" className="mt-1" onClick={() => copy(snippet)}>
                  <Copy className="h-3.5 w-3.5" /> Copy snippet
                </Button>
              </div>
              {shown.kind === 'mcp' ? (
                <p className="text-xs text-muted">
                  After editing the config, run /reload-mcp in Hermes.
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setShown(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SecurityCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: getMe });
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [next2, setNext2] = React.useState('');
  const [pending, setPending] = React.useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = React.useState('');

  const changePw = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setNext2('');
      toast.success('Password changed');
    },
    onError: (e) => toast.error('Password change failed', errorMessage(e)),
  });
  const totpSetup = useMutation({
    mutationFn: authApi.totpSetup,
    onSuccess: (r) => setPending(r),
    onError: (e) => toast.error('TOTP setup failed', errorMessage(e)),
  });
  const totpEnable = useMutation({
    mutationFn: () => authApi.totpEnable(code),
    onSuccess: () => {
      setPending(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success('TOTP enabled');
    },
    onError: (e) => toast.error('Could not enable TOTP', errorMessage(e)),
  });
  const totpDisable = useMutation({
    mutationFn: () => authApi.totpDisable(code),
    onSuccess: () => {
      setCode('');
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success('TOTP disabled');
    },
    onError: (e) => toast.error('Could not disable TOTP', errorMessage(e)),
  });

  const mismatch = next2.length > 0 && next !== next2;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>UI password (argon2id) and optional TOTP second factor.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch && next.length >= 12) changePw.mutate();
          }}
        >
          <div className="text-sm font-medium">Change password</div>
          <Field label="Current password" htmlFor="cpw">
            <Input
              id="cpw"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" htmlFor="npw" hint="At least 12 characters.">
              <Input
                id="npw"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <Field label="Repeat" htmlFor="npw2">
              <Input
                id="npw2"
                type="password"
                autoComplete="new-password"
                value={next2}
                onChange={(e) => setNext2(e.target.value)}
              />
            </Field>
          </div>
          {mismatch ? <ErrorBox message="Passwords do not match." /> : null}
          <div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={changePw.isPending || !current || next.length < 12 || mismatch}
            >
              Change password
            </Button>
          </div>
        </form>

        <div className="grid gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            Two-factor (TOTP){' '}
            {me.data?.totpEnabled ? (
              <Badge variant="success">enabled</Badge>
            ) : (
              <Badge variant="muted">off</Badge>
            )}
          </div>
          {me.data?.totpEnabled ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Current code" htmlFor="tdc">
                <Input
                  id="tdc"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-40"
                />
              </Field>
              <Button
                size="sm"
                variant="outline"
                className="text-danger"
                onClick={() => totpDisable.mutate()}
                disabled={totpDisable.isPending || !code}
              >
                Disable TOTP
              </Button>
            </div>
          ) : pending ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted">
                Add this to your authenticator app, then enter a code to enable.
              </p>
              <pre className="overflow-x-auto rounded-md border border-border bg-accent p-2 text-xs break-all whitespace-pre-wrap">
                {pending.otpauthUrl}
              </pre>
              <div className="text-xs">
                Secret: <code className="font-mono">{pending.secret}</code>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Code" htmlFor="tec">
                  <Input
                    id="tec"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-40"
                  />
                </Field>
                <Button
                  size="sm"
                  onClick={() => totpEnable.mutate()}
                  disabled={totpEnable.isPending || !code}
                >
                  Enable TOTP
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => totpSetup.mutate()}
                disabled={totpSetup.isPending}
              >
                Set up TOTP
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SystemCard() {
  const sys = useQuery({ queryKey: ['system'], queryFn: systemApi.get, refetchInterval: 30_000 });
  const s = sys.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {sys.isError ? <ErrorBox message={errorMessage(sys.error)} /> : null}
        {s ? (
          <div className="flex flex-col gap-2">
            {s.codeDelivery === 'returned' ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
                No direct Hermes route configured: codes are returned to the agent (soft mode).
              </div>
            ) : (
              <div className="rounded-md border border-success/40 bg-success/10 p-2 text-success">
                Codes are delivered directly to SimpleX (direct mode).
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted">
              <dt>Version</dt>
              <dd className="font-mono text-xs">{s.version}</dd>
              <dt>Uptime</dt>
              <dd>{fmtRelative(Date.now() - s.uptimeMs).replace(' ago', '')}</dd>
              <dt>Scheduler</dt>
              <dd>
                {s.scheduler.running ? 'running' : 'stopped'}
                {s.scheduler.lastTickAt
                  ? ` · last tick ${fmtRelative(s.scheduler.lastTickAt)}`
                  : ''}
                {s.scheduler.lagMs !== null
                  ? ` · lag ${Math.round(s.scheduler.lagMs / 1000)}s`
                  : ''}
              </dd>
              <dt>Counts</dt>
              <dd>
                {s.counts.scheduled} scheduled · {s.counts.publishing} publishing ·{' '}
                {s.counts.failed24h} failed (24 h)
              </dd>
              <dt>Server zone</dt>
              <dd>{s.tz}</dd>
            </dl>
          </div>
        ) : (
          <p className="text-muted">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}

function NotificationsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['notifications', 'undelivered'],
    queryFn: () => notificationsApi.list(true, 50),
    refetchInterval: 60_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => notificationsApi.retry(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Delivery retried');
    },
    onError: (e) => toast.error('Retry failed', errorMessage(e)),
  });
  const items = list.data ?? [];
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Undelivered notifications</CardTitle>
        <CardDescription>
          Webhook events that have not reached Hermes yet. Retries continue with backoff for 24
          hours.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list.isError ? <ErrorBox message={errorMessage(list.error)} /> : null}
        {!list.isLoading && items.length === 0 ? (
          <p className="text-sm text-muted">All notifications delivered.</p>
        ) : null}
        {items.length ? (
          <Table>
            <THead>
              <TR>
                <TH>Created</TH>
                <TH>Event</TH>
                <TH>Route</TH>
                <TH>Attempts</TH>
                <TH>Last error</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {items.map((n) => (
                <TR key={n.id}>
                  <TD className="whitespace-nowrap">{fmtLocal(n.createdAt)}</TD>
                  <TD className="font-mono text-xs">{n.event}</TD>
                  <TD className="font-mono text-xs">{n.route}</TD>
                  <TD>
                    {n.attempts}
                    {n.nextAttemptAt ? (
                      <div className="text-xs text-muted">next {fmtRelative(n.nextAttemptAt)}</div>
                    ) : null}
                  </TD>
                  <TD className="max-w-[280px] break-words text-xs text-muted">
                    {n.lastError ?? '—'}
                  </TD>
                  <TD>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => retry.mutate(n.id)}
                      disabled={retry.isPending}
                    >
                      Retry
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
