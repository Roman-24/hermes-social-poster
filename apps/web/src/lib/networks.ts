import type { Network } from '@poster/core';

/** Mirrors `NETWORKS` / `NETWORK_LABELS` in @poster/core without pulling its runtime deps into the bundle. */
export const NETWORKS: readonly Network[] = ['x', 'farcaster', 'linkedin', 'nostr', 'bluesky'];

export const NETWORK_LABELS: Record<Network, string> = {
  x: 'X',
  farcaster: 'Farcaster',
  linkedin: 'LinkedIn',
  nostr: 'Nostr',
  bluesky: 'Bluesky',
};
