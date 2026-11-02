import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import { getMe } from '@/lib/api';
import { AppLayout } from '@/components/layout';
import { LoginPage } from '@/pages/login';
import { AccountsPage } from '@/pages/accounts';
import { RemoteBrowserPage } from '@/pages/remote-browser';
import { QueuePage } from '@/pages/queue';
import { HistoryPage } from '@/pages/history';
import { PostDetailPage } from '@/pages/post-detail';
import { SettingsPage } from '@/pages/settings';

export interface RouterContext {
  queryClient: QueryClient;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <div className="p-8 text-sm text-muted">
      Not found.{' '}
      <a href="/queue" className="underline">
        Go to the queue
      </a>
      .
    </div>
  ),
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

/** Pathless layout: everything under it requires a UI session. */
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery({
      queryKey: ['auth', 'me'],
      queryFn: getMe,
      staleTime: 10_000,
    });
    if (!me.authenticated) throw redirect({ to: '/login' });
  },
  component: AppLayout,
});

export const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/queue' });
  },
});

export const accountsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/accounts',
  validateSearch: z.object({
    connected: z.string().optional(),
    error: z.string().optional(),
  }),
  component: AccountsPage,
});

export const remoteBrowserRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/accounts/$network/browser/$sessionId',
  component: RemoteBrowserPage,
});

export const queueRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/queue',
  component: QueuePage,
});

export const historyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/history',
  component: HistoryPage,
});

export const postDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/posts/$postId',
  component: PostDetailPage,
});

export const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([
    indexRoute,
    accountsRoute,
    remoteBrowserRoute,
    queueRoute,
    historyRoute,
    postDetailRoute,
    settingsRoute,
  ]),
]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
