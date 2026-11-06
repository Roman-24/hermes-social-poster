import {
  formatInZone,
  hasManualBreaks,
  measureAgainst,
  PosterError,
  resolveSchedule,
  splitManual,
  splitThread,
  ThreadSplitError,
  type Issue,
  type MediaInfo,
  type MediaRef,
  type Network,
  type NetworkPreview,
  type RenderedPost,
  type ScheduleInput,
  type ScheduleView,
} from '@poster/core';
import type { AccountService } from './accounts.js';
import type { MediaService } from './media.js';
import type { SettingsService } from './settings.js';

export interface RenderInput {
  postId: string;
  baseText: string;
  threadMode: 'auto' | 'off';
  networks: Network[];
  overrides: Record<string, { text?: string; mediaIds?: string[] }>;
  /** Ordered media for all networks (post_media rows with network = null). */
  media: { info: MediaInfo; altText: string | null }[];
  /** Per-network media overrides (post_media rows with a network). */
  mediaByNetwork: Partial<Record<Network, { info: MediaInfo; altText: string | null }[]>>;
  schedule: { atUtcMs: number; tz: string; localInput: string };
  scheduleOverrides: Record<string, unknown>;
  /** Existing target ids by network (when re-rendering a stored post). */
  targetIds?: Partial<Record<Network, string>>;
  /** Frozen parts (publish time): skip splitting and use these texts. */
  frozenParts?: Partial<Record<Network, string[]>>;
}

export interface RenderedNetwork {
  network: Network;
  rendered: RenderedPost;
  issues: Issue[];
  schedule: ScheduleView;
  connected: boolean;
  handle: string | null;
}

/**
 * Turns a post into per-network rendered versions: text overrides, thread split, media
 * variants, per-network schedule, adapter validation. Used for previews and at publish time.
 */
export class Renderer {
  constructor(
    private readonly settings: SettingsService,
    private readonly accounts: AccountService,
    private readonly media: MediaService,
  ) {}

  async renderAll(input: RenderInput, nowMs = Date.now()): Promise<RenderedNetwork[]> {
    const out: RenderedNetwork[] = [];
    for (const network of input.networks) out.push(await this.renderOne(input, network, nowMs));
    return out;
  }

  async renderOne(
    input: RenderInput,
    network: Network,
    nowMs = Date.now(),
  ): Promise<RenderedNetwork> {
    const settings = this.settings.get();
    const limits = this.settings.limitsFor(network);
    const adapter = this.accounts.adapter(network);
    const account = this.accounts.getState(network);
    const ctx = this.accounts.adapterContext(network);
    const issues: Issue[] = [];

    /* ---- schedule (per-network override or the post's) ---- */
    let schedule: ScheduleView;
    const override = input.scheduleOverrides[network] as ScheduleInput | undefined;
    if (override !== undefined) {
      const r = resolveSchedule(override, settings.defaultTz, nowMs);
      schedule = {
        atUtcMs: r.atUtcMs,
        tz: r.tz,
        isoLocal: r.isoLocal,
        isoUtc: r.isoUtc,
        display: r.display,
        immediate: r.immediate,
      };
    } else {
      const f = formatInZone(input.schedule.atUtcMs, input.schedule.tz);
      schedule = {
        atUtcMs: input.schedule.atUtcMs,
        tz: input.schedule.tz,
        ...f,
        immediate: input.schedule.localInput === 'now',
      };
    }

    /* ---- text + thread ---- */
    const text = (input.overrides[network]?.text ?? input.baseText).trim();
    let parts: string[];
    let thread = false;
    const frozen = input.frozenParts?.[network];
    if (frozen && frozen.length > 0) {
      parts = frozen;
      thread = frozen.length > 1;
    } else if (hasManualBreaks(text)) {
      if (!limits.threads) {
        issues.push({
          level: 'error',
          code: 'THREADS_UNSUPPORTED',
          network,
          message: 'Manual part breaks (---) are not supported on this network.',
        });
        parts = [text];
      } else {
        try {
          parts = splitThread(text, { limits: limits.text, marker: settings.threadMarker }).parts;
          thread = parts.length > 1;
        } catch (err) {
          issues.push({
            level: 'error',
            code: 'THREAD_SPLIT',
            network,
            message: err instanceof Error ? err.message : String(err),
          });
          parts = splitManual(text);
        }
      }
    } else if (input.threadMode === 'auto' && limits.threads && limits.text.unit !== 'none') {
      try {
        const r = splitThread(text, { limits: limits.text, marker: settings.threadMarker });
        parts = r.parts;
        thread = parts.length > 1;
        for (const note of r.issues)
          issues.push({ level: 'warning', code: 'THREAD_NOTE', network, message: note });
      } catch (err) {
        if (err instanceof ThreadSplitError) {
          issues.push({ level: 'error', code: 'THREAD_SPLIT', network, message: err.message });
          parts = [text];
        } else throw err;
      }
    } else {
      parts = [text];
    }

    /* ---- media variants ---- */
    const mediaList =
      input.mediaByNetwork[network] ?? resolveOverrideMedia(input, network) ?? input.media;
    const refs: MediaRef[] = [];
    // Count before work: a variant lookup is a database read, a file check and possibly an image
    // re-encode per attachment, so a list the network can never accept must not reach it.
    const maxAttachments = limits.images.max + (limits.video?.max ?? 0);
    const tooMany = mediaList.length > maxAttachments;
    if (tooMany) {
      issues.push({
        level: 'error',
        code: 'TOO_MANY_MEDIA',
        network,
        message: `${mediaList.length} attachments, but ${network} accepts at most ${maxAttachments}.`,
      });
    }
    for (const m of tooMany ? [] : mediaList) {
      try {
        const ref = await this.media.variantFor(m.info, network, limits);
        if (m.altText) ref.altText = m.altText;
        refs.push(ref);
      } catch (err) {
        const pe = PosterError.from(err, 'MEDIA_UNSUPPORTED');
        issues.push({
          level: 'error',
          code: pe.code,
          network,
          mediaId: m.info.id,
          message: pe.message,
        });
      }
    }

    const rendered: RenderedPost = {
      postId: input.postId,
      targetId: input.targetIds?.[network] ?? '',
      network,
      parts: parts.map((p, i) => ({ text: p, media: i === 0 ? refs : [] })),
      scheduledAtUtc: schedule.atUtcMs,
      thread,
    };

    /* ---- connection + adapter validation ---- */
    const connected = !!account?.secrets && account.status === 'connected';
    if (!connected) {
      issues.push({
        level: 'error',
        code: account?.status === 'needs_auth' ? 'AUTH_REQUIRED' : 'NOT_CONNECTED',
        network,
        message:
          account?.status === 'needs_auth'
            ? `${network}: login required; reconnect in the UI.`
            : `${network} is not connected. Connect it in the UI first.`,
      });
    }
    try {
      issues.push(...adapter.validate(rendered, account, ctx));
    } catch (err) {
      issues.push({
        level: 'error',
        code: 'VALIDATION',
        network,
        message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return {
      network,
      rendered,
      issues: dedupeIssues(issues),
      schedule,
      connected,
      handle: account?.handle ?? null,
    };
  }

  toPreview(r: RenderedNetwork): NetworkPreview {
    const limits = this.settings.limitsFor(r.network);
    return {
      network: r.network,
      connected: r.connected,
      handle: r.handle,
      thread: r.rendered.thread,
      parts: r.rendered.parts.map((p) => {
        const m = measureAgainst(p.text, limits.text);
        return {
          text: p.text,
          count: m.count,
          max: m.max,
          unit: m.unit,
          ...(m.bytes !== undefined ? { bytes: m.bytes, maxBytes: m.maxBytes } : {}),
          media: p.media.map((ref) => ({
            id: ref.id,
            kind: ref.kind,
            mime: ref.mime,
            bytes: ref.bytes,
            width: ref.width ?? null,
            height: ref.height ?? null,
            durationMs: ref.durationMs ?? null,
            altText: ref.altText ?? null,
          })),
        };
      }),
      schedule: r.schedule,
      issues: r.issues,
    };
  }
}

function resolveOverrideMedia(
  input: RenderInput,
  network: Network,
): { info: MediaInfo; altText: string | null }[] | null {
  const ids = input.overrides[network]?.mediaIds;
  if (!ids) return null;
  const byId = new Map<string, { info: MediaInfo; altText: string | null }>();
  for (const m of input.media) byId.set(m.info.id, m);
  for (const list of Object.values(input.mediaByNetwork))
    for (const m of list ?? []) byId.set(m.info.id, m);
  return ids
    .map((id) => byId.get(id))
    .filter((m): m is { info: MediaInfo; altText: string | null } => !!m);
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.level}|${i.code}|${i.network ?? ''}|${i.part ?? ''}|${i.mediaId ?? ''}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
