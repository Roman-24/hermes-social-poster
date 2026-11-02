import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Clock, History, LogOut, Settings, Users } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { logout } from '@/lib/api';
import { useLiveEvents } from '@/lib/ws';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const NAV = [
  { to: '/accounts', label: 'Accounts', icon: Users },
  { to: '/queue', label: 'Queue', icon: Clock },
  { to: '/history', label: 'History', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export function AppLayout() {
  useLiveEvents(true);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const logoutMut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      void navigate({ to: '/login' });
    },
  });

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="border-b border-border bg-card md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-3 md:block md:py-4">
          <Link to="/queue" className="text-base font-semibold tracking-tight">
            Social Poster
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => logoutMut.mutate()}
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-2 md:pb-0">
          {NAV.map((item) => {
            const active =
              pathname === item.to ||
              pathname.startsWith(`${item.to}/`) ||
              (item.to === '/history' && pathname.startsWith('/posts/'));
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent',
                  active ? 'bg-accent font-medium' : 'text-muted',
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden px-2 pt-4 md:block">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted"
            onClick={() => logoutMut.mutate()}
          >
            <LogOut className="h-4 w-4" /> Log out
          </Button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="mx-auto w-full max-w-[1100px] px-4 py-5 md:px-6 md:py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="mt-1 text-sm text-muted">{description}</div> : null}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
      {message}
    </div>
  );
}
