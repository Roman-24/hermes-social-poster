import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage, getMe, login, setupPassword } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ErrorBox } from '@/components/layout';

export function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: getMe, retry: false });
  const [password, setPassword] = React.useState('');
  const [totp, setTotp] = React.useState('');
  const [needTotp, setNeedTotp] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (me.data?.authenticated) void navigate({ to: '/queue', replace: true });
  }, [me.data?.authenticated, navigate]);

  const setupMut = useMutation({
    mutationFn: (pw: string) => setupPassword(pw),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const loginMut = useMutation({
    mutationFn: () => login(password, totp || undefined),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      void navigate({ to: '/queue', replace: true });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.extra.totpRequired) {
        setNeedTotp(true);
        setError('Enter the code from your authenticator app.');
        return;
      }
      setError(errorMessage(e));
    },
  });

  const setupRequired = me.data?.setupRequired === true;
  const showTotp = needTotp || me.data?.totpEnabled === true;

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Social Poster</CardTitle>
          <CardDescription>
            {setupRequired
              ? 'First run: set the password for this UI.'
              : 'Sign in to manage accounts and the queue.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {me.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : setupRequired ? (
            <SetupForm
              busy={setupMut.isPending}
              error={error}
              onSubmit={(pw) => setupMut.mutate(pw)}
            />
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                loginMut.mutate();
              }}
            >
              <Field label="Password" htmlFor="pw">
                <Input
                  id="pw"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </Field>
              {showTotp ? (
                <Field label="Authenticator code" htmlFor="totp">
                  <Input
                    id="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                  />
                </Field>
              ) : null}
              {error ? <ErrorBox message={error} /> : null}
              <Button type="submit" disabled={loginMut.isPending || !password}>
                {loginMut.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SetupForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (pw: string) => void;
}) {
  const [pw, setPw] = React.useState('');
  const [pw2, setPw2] = React.useState('');
  const mismatch = pw2.length > 0 && pw !== pw2;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mismatch && pw.length >= 12) onSubmit(pw);
      }}
    >
      <Field label="New password" htmlFor="npw" hint="At least 12 characters.">
        <Input
          id="npw"
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
        />
      </Field>
      <Field label="Repeat password" htmlFor="npw2">
        <Input
          id="npw2"
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </Field>
      {mismatch ? <ErrorBox message="Passwords do not match." /> : null}
      {error ? <ErrorBox message={error} /> : null}
      <Button type="submit" disabled={busy || mismatch || pw.length < 12}>
        {busy ? 'Saving…' : 'Set password'}
      </Button>
    </form>
  );
}
