import type { Network } from './networks.js';

/**
 * Per-network limits. Single source of truth; checked against current docs before each release.
 * Text units:
 *  - weighted: X's weighted count (twitter-text), URLs count as 23.
 *  - bytes: UTF-8 byte length (Farcaster).
 *  - graphemes: user-perceived characters (Bluesky primary limit; secondary byte cap applies).
 *  - chars: UTF-16 code points via Array.from (LinkedIn).
 *  - none: no hard limit; a configurable soft cap applies (Nostr).
 */
export type TextUnit = 'weighted' | 'bytes' | 'graphemes' | 'chars' | 'none';

export interface TextLimits {
  max: number;
  unit: TextUnit;
  /** Bluesky: 3,000 bytes in addition to 300 graphemes. */
  secondaryMaxBytes?: number;
}

export interface ImageLimits {
  /** Max images per post part. 0 = images not supported. */
  max: number;
  maxBytes: number;
  /** Accepted output MIME types. Others are converted by the media pipeline. */
  mimes: readonly string[];
  /** Max long edge in px; the pipeline downsizes beyond this. */
  maxEdge: number;
}

export interface VideoLimits {
  max: number;
  maxBytes: number;
  maxDurationMs: number;
  mimes: readonly string[];
}

export interface NetworkLimits {
  text: TextLimits;
  images: ImageLimits;
  /** null = video not supported (or not verified). */
  video: VideoLimits | null;
  /** Can images and a video be mixed in one part? */
  mixMediaKinds: boolean;
  threads: boolean;
  altText: boolean;
  /** Human-readable notes shown in the UI / previews. */
  notes: readonly string[];
}

const MB = 1024 * 1024;

export const DEFAULT_LIMITS: Record<Network, NetworkLimits> = {
  x: {
    text: { max: 280, unit: 'weighted' },
    images: {
      max: 4,
      maxBytes: 5 * MB,
      mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      maxEdge: 4096,
    },
    video: { max: 1, maxBytes: 512 * MB, maxDurationMs: 140_000, mimes: ['video/mp4'] },
    mixMediaKinds: false,
    threads: true,
    altText: true,
    notes: ['280 weighted characters (no Premium); longer text becomes a thread.'],
  },
  farcaster: {
    text: { max: 320, unit: 'bytes' },
    images: {
      max: 2,
      maxBytes: 10 * MB,
      mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      maxEdge: 4096,
    },
    // Video via the farcaster.xyz web composer is unverified (Milestone 4). Until verified it is skipped with a warning.
    video: null,
    mixMediaKinds: false,
    threads: true,
    altText: false,
    notes: [
      '320 bytes and 2 embeds (no Pro). Video is not published to Farcaster until the web composer is verified.',
    ],
  },
  linkedin: {
    text: { max: 3000, unit: 'chars' },
    images: {
      max: 20,
      maxBytes: 8 * MB,
      mimes: ['image/jpeg', 'image/png', 'image/gif'],
      maxEdge: 7680,
    },
    video: { max: 1, maxBytes: 200 * MB, maxDurationMs: 10 * 60_000, mimes: ['video/mp4'] },
    mixMediaKinds: false,
    threads: false,
    altText: true,
    notes: ['Never split into threads; over 3,000 characters is a validation error.'],
  },
  nostr: {
    // Soft cap only; overridable in settings (limits.nostr.text.max).
    text: { max: 5000, unit: 'none' },
    images: {
      max: 10,
      maxBytes: 50 * MB,
      mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      maxEdge: 4096,
    },
    video: { max: 1, maxBytes: 100 * MB, maxDurationMs: 10 * 60_000, mimes: ['video/mp4'] },
    mixMediaKinds: true,
    threads: true,
    altText: true,
    notes: [
      'Media uploaded to Blossom is public and stays downloadable by anyone with the link, even after the note is deleted.',
    ],
  },
  bluesky: {
    text: { max: 300, unit: 'graphemes', secondaryMaxBytes: 3000 },
    // The PDS rejects image blobs over 1,000,000 bytes; the pipeline re-encodes down to this.
    images: {
      max: 4,
      maxBytes: 1_000_000,
      mimes: ['image/jpeg', 'image/png', 'image/webp'],
      maxEdge: 2000,
    },
    video: { max: 1, maxBytes: 300 * MB, maxDurationMs: 10 * 60_000, mimes: ['video/mp4'] },
    mixMediaKinds: false,
    threads: true,
    altText: true,
    notes: [
      '300 graphemes / 3,000 bytes. Images and video cannot be mixed. Video upload needs a verified email.',
    ],
  },
};

/** Deep-merge a partial override (from settings) over the defaults. */
export function mergeLimits(
  base: Record<Network, NetworkLimits>,
  override:
    | Partial<
        Record<
          Network,
          Partial<{
            text: Partial<TextLimits>;
            images: Partial<ImageLimits>;
            video: Partial<VideoLimits> | null;
          }>
        >
      >
    | undefined,
): Record<Network, NetworkLimits> {
  if (!override) return base;
  const out = { ...base } as Record<Network, NetworkLimits>;
  for (const key of Object.keys(override) as Network[]) {
    const o = override[key];
    const b = base[key];
    if (!o || !b) continue;
    out[key] = {
      ...b,
      text: { ...b.text, ...(o.text ?? {}) },
      images: { ...b.images, ...(o.images ?? {}) },
      video:
        o.video === null
          ? null
          : o.video
            ? {
                ...(b.video ?? { max: 1, maxBytes: 0, maxDurationMs: 0, mimes: ['video/mp4'] }),
                ...o.video,
              }
            : b.video,
    };
  }
  return out;
}
