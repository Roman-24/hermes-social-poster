import { mkdirSync } from 'node:fs';
import {
  BrowserManager,
  createBlueskyAdapter,
  createFakeAdapter,
  createFarcasterAdapter,
  createLinkedInAdapter,
  createNostrAdapter,
  createXAdapter,
  type BrowserManagerApi,
} from '@poster/adapters';
import { NETWORKS, type NetworkAdapter } from '@poster/core';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { AdapterRegistry } from './services/accounts.js';
import type { SettingsService } from './services/settings.js';

export function buildAdapters(
  config: Config,
  settings: SettingsService,
  logger: Logger,
): { adapters: AdapterRegistry; browser: BrowserManagerApi } {
  mkdirSync(config.browserDir, { recursive: true });
  const s = settings.get();
  const browser = new BrowserManager({
    logger: logger.child({ component: 'browser' }),
    chromiumPath: config.CHROMIUM_PATH,
    typingDelayMs: { min: s.browser.typingDelayMsMin, max: s.browser.typingDelayMsMax },
  });

  if (config.fakeAdapters) {
    logger.warn(
      'POSTER_FAKE_ADAPTERS is set: every network uses the in-memory fake adapter. Nothing will be published.',
    );
    const adapters = Object.fromEntries(
      NETWORKS.map((n) => [n, createFakeAdapter(n)]),
    ) as unknown as AdapterRegistry;
    return { adapters, browser };
  }

  const adapters: Record<string, NetworkAdapter> = {
    x: createXAdapter(browser),
    farcaster: createFarcasterAdapter(browser),
    nostr: createNostrAdapter(),
    bluesky: createBlueskyAdapter(),
    linkedin: createLinkedInAdapter({
      async getClientCredentials() {
        const clientId = settings.getSecret('linkedin.clientId');
        const clientSecret = settings.getSecret('linkedin.clientSecret');
        return clientId && clientSecret ? { clientId, clientSecret } : null;
      },
    }),
  };
  return { adapters: adapters as AdapterRegistry, browser };
}
