import type { MediaRef } from './media.js';
import type { Network } from './networks.js';

/** One thread part as the adapter will publish it. */
export interface RenderedPart {
  text: string;
  media: MediaRef[];
}

/** The fully rendered, per-network version of a post. */
export interface RenderedPost {
  postId: string;
  targetId: string;
  network: Network;
  parts: RenderedPart[];
  /** UTC epoch ms this target is due. */
  scheduledAtUtc: number;
  /** True when the text was auto-split. */
  thread: boolean;
  /** Remote ids of parts already published in an earlier attempt (resume from parts.length). */
  publishedRemoteIds?: string[];
}

export interface PublishResult {
  /** Canonical URL of the (first part of the) post, when known. */
  url?: string;
  /** Remote ids, one per thread part, in order. */
  remoteIds: string[];
  /** Nostr: number of relays that returned OK. */
  relaysOk?: number;
  relaysTotal?: number;
  /** Debug data stored on the attempt row (no secrets). */
  debug?: Record<string, unknown>;
}

/** Thrown by adapters when a thread failed part-way: earlier parts stay published. */
export class PartialPublishError extends Error {
  override readonly cause: unknown;
  constructor(
    public readonly publishedRemoteIds: string[],
    public readonly failedPartIndex: number,
    cause: unknown,
  ) {
    super(
      `Thread failed at part ${failedPartIndex + 1}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PartialPublishError';
    this.cause = cause;
  }
}
