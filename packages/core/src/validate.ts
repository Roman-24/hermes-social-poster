import type { Issue } from './issues.js';
import type { NetworkLimits } from './limits.js';
import type { MediaRef } from './media.js';
import type { Network } from './networks.js';
import type { RenderedPost } from './post.js';
import { measureAgainst } from './text.js';

/**
 * Network-agnostic validation shared by all adapters: text length per part, media counts,
 * media kinds, sizes and durations. Adapters add network-specific checks on top.
 */
export function validateAgainstLimits(post: RenderedPost, limits: NetworkLimits): Issue[] {
  const issues: Issue[] = [];
  const network: Network = post.network;

  post.parts.forEach((part, idx) => {
    const m = measureAgainst(part.text, limits.text);
    if (m.over && limits.text.unit !== 'none') {
      issues.push({
        level: 'error',
        code: 'TEXT_TOO_LONG',
        network,
        part: idx,
        message: `Part ${idx + 1} is ${m.count}/${m.max} ${m.unit}${m.bytes !== undefined && m.maxBytes !== undefined && m.bytes > m.maxBytes ? ` and ${m.bytes}/${m.maxBytes} bytes` : ''}.`,
      });
    } else if (m.over) {
      issues.push({
        level: 'warning',
        code: 'TEXT_OVER_SOFT_CAP',
        network,
        part: idx,
        message: `Part ${idx + 1} is ${m.count} characters, over the soft cap of ${m.max}.`,
      });
    }
    if (!part.text.trim() && part.media.length === 0) {
      issues.push({
        level: 'error',
        code: 'EMPTY_PART',
        network,
        part: idx,
        message: `Part ${idx + 1} is empty.`,
      });
    }
    issues.push(...validateMedia(part.media, limits, network, idx));
  });

  if (post.parts.length > 1 && !limits.threads) {
    issues.push({
      level: 'error',
      code: 'THREADS_UNSUPPORTED',
      network,
      message: 'This network does not support threads.',
    });
  }
  return issues;
}

export function validateMedia(
  media: MediaRef[],
  limits: NetworkLimits,
  network: Network,
  part?: number,
): Issue[] {
  const issues: Issue[] = [];
  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');

  if (images.length > limits.images.max) {
    issues.push({
      level: 'error',
      code: 'TOO_MANY_IMAGES',
      network,
      part,
      message: `${images.length} images, but the limit is ${limits.images.max}.`,
    });
  }
  if (videos.length > 0 && !limits.video) {
    issues.push({
      level: 'warning',
      code: 'VIDEO_UNSUPPORTED',
      network,
      part,
      message: 'Video is not supported on this network and will be skipped.',
    });
  } else if (limits.video && videos.length > limits.video.max) {
    issues.push({
      level: 'error',
      code: 'TOO_MANY_VIDEOS',
      network,
      part,
      message: `${videos.length} videos, but the limit is ${limits.video.max}.`,
    });
  }
  if (images.length > 0 && videos.length > 0 && !limits.mixMediaKinds) {
    issues.push({
      level: 'error',
      code: 'MIXED_MEDIA',
      network,
      part,
      message: 'Images and video cannot be mixed in one post on this network.',
    });
  }
  for (const img of images) {
    if (img.bytes > limits.images.maxBytes) {
      issues.push({
        level: 'error',
        code: 'IMAGE_TOO_LARGE',
        network,
        part,
        mediaId: img.id,
        message: `Image ${img.id} is ${fmtBytes(img.bytes)}, over the ${fmtBytes(limits.images.maxBytes)} limit.`,
      });
    }
    if (!limits.images.mimes.includes(img.mime)) {
      issues.push({
        level: 'error',
        code: 'IMAGE_TYPE_UNSUPPORTED',
        network,
        part,
        mediaId: img.id,
        message: `Image type ${img.mime} is not accepted by this network.`,
      });
    }
  }
  if (limits.video) {
    for (const v of videos) {
      if (v.bytes > limits.video.maxBytes) {
        issues.push({
          level: 'error',
          code: 'VIDEO_TOO_LARGE',
          network,
          part,
          mediaId: v.id,
          message: `Video ${v.id} is ${fmtBytes(v.bytes)}, over the ${fmtBytes(limits.video.maxBytes)} limit.`,
        });
      }
      if ((v.durationMs ?? 0) > limits.video.maxDurationMs) {
        issues.push({
          level: 'error',
          code: 'VIDEO_TOO_LONG',
          network,
          part,
          mediaId: v.id,
          message: `Video ${v.id} is ${Math.round((v.durationMs ?? 0) / 1000)}s, over the ${Math.round(limits.video.maxDurationMs / 1000)}s limit.`,
        });
      }
      if (!limits.video.mimes.includes(v.mime)) {
        issues.push({
          level: 'error',
          code: 'VIDEO_TYPE_UNSUPPORTED',
          network,
          part,
          mediaId: v.id,
          message: `Video type ${v.mime} is not accepted by this network.`,
        });
      }
    }
  }
  return issues;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
