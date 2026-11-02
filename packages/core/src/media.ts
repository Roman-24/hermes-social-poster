import { z } from 'zod';
import type { Network } from './networks.js';

export const MediaKindSchema = z.enum(['image', 'video']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const ALLOWED_MIMES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
} as const;

export function kindForMime(mime: string): MediaKind | null {
  if ((ALLOWED_MIMES.image as readonly string[]).includes(mime)) return 'image';
  if ((ALLOWED_MIMES.video as readonly string[]).includes(mime)) return 'video';
  return null;
}

/** One processed, network-specific file (resized/transcoded). */
export interface MediaVariant {
  path: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Media record as stored, without per-network variants resolved. */
export const MediaInfoSchema = z.object({
  id: z.string(),
  kind: MediaKindSchema,
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  altText: z.string().nullable().optional(),
  createdAt: z.number().int(),
  /** Per-network compatibility, computed at upload time. */
  compatibility: z
    .record(z.string(), z.object({ ok: z.boolean(), reason: z.string().optional() }))
    .optional(),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

/** What an adapter receives: the variant chosen for its network plus metadata. */
export interface MediaRef {
  id: string;
  kind: MediaKind;
  /** Absolute path of the variant to upload for this network. */
  path: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  sha256: string;
  /** Nostr: Blossom URLs after upload (filled by the adapter, cached on the media row). */
  blossomUrls?: string[];
}

export type MediaCompatibility = Partial<Record<Network, { ok: boolean; reason?: string }>>;
