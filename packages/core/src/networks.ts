import { z } from 'zod';

/** The five supported networks. Exactly one account per network (v1). */
export const NETWORKS = ['x', 'farcaster', 'linkedin', 'nostr', 'bluesky'] as const;
export type Network = (typeof NETWORKS)[number];
export const NetworkSchema = z.enum(NETWORKS);

export const NETWORK_LABELS: Record<Network, string> = {
  x: 'X',
  farcaster: 'Farcaster',
  linkedin: 'LinkedIn',
  nostr: 'Nostr',
  bluesky: 'Bluesky',
};

export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
}
