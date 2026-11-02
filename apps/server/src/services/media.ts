import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { eq, inArray } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import {
  kindForMime,
  newId,
  NETWORKS,
  PosterError,
  type MediaCompatibility,
  type MediaInfo,
  type MediaKind,
  type MediaRef,
  type MediaSummary,
  type MediaUploadResult,
  type Network,
  type NetworkLimits,
} from '@poster/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { media as mediaTable } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from './settings.js';

const execFileAsync = promisify(execFile);

const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

interface Probe {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  videoCodec?: string;
  audioCodec?: string;
}

/**
 * Media pipeline: ingest once (from the inbox or a multipart upload), store under
 * /data/media/<sha256>/, probe, and derive per-network variants lazily at render time.
 */
export class MediaService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {
    mkdirSync(this.config.mediaDir, { recursive: true });
  }

  /* ------------------------------------------------------------------ */
  /* Inbox path mapping                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Map a host path reported by Hermes onto the container mount and verify it resolves inside
   * the inbox after realpath (blocks traversal and symlink tricks).
   */
  resolveInboxPath(input: string): string {
    if (typeof input !== 'string' || !input.startsWith('/')) {
      throw new PosterError('VALIDATION', 'Media path must be absolute.');
    }
    let mapped = input;
    const prefix = this.config.INBOX_HOST_PREFIX.replace(/\/+$/, '');
    if (prefix && (mapped === prefix || mapped.startsWith(prefix + '/'))) {
      mapped = join(this.config.INBOX_DIR, mapped.slice(prefix.length));
    }
    if (!existsSync(this.config.INBOX_DIR)) {
      throw new PosterError(
        'VALIDATION',
        `Inbox directory ${this.config.INBOX_DIR} is not mounted.`,
      );
    }
    const inboxReal = realpathSync(this.config.INBOX_DIR);
    let real: string;
    try {
      real = realpathSync(mapped);
    } catch {
      throw new PosterError('NOT_FOUND', `Media file not found in the inbox: ${basename(input)}`);
    }
    const rel = relative(inboxReal, real);
    if (rel.startsWith('..') || rel.split(sep)[0] === '..' || resolve(inboxReal, rel) !== real) {
      throw new PosterError('FORBIDDEN', 'Media path is outside the inbox directory.');
    }
    if (!statSync(real).isFile())
      throw new PosterError('VALIDATION', 'Media path is not a regular file.');
    return real;
  }

  /* ------------------------------------------------------------------ */
  /* Ingest                                                               */
  /* ------------------------------------------------------------------ */

  async ingestFromInbox(hostPath: string, altText?: string): Promise<MediaUploadResult> {
    const real = this.resolveInboxPath(hostPath);
    const buf = await readFile(real);
    return this.ingestBuffer(buf, { sourcePath: hostPath, altText, originalName: basename(real) });
  }

  async ingestBuffer(
    buf: Buffer,
    opts: { sourcePath?: string; altText?: string; originalName?: string } = {},
  ): Promise<MediaUploadResult> {
    const ft = await fileTypeFromBuffer(buf);
    const mime = normaliseMime(ft?.mime);
    const kind = mime ? kindForMime(mime) : null;
    if (!mime || !kind) {
      throw new PosterError(
        'MEDIA_UNSUPPORTED',
        `Unsupported media type${ft ? ` ${ft.mime}` : ''}. Allowed: JPEG, PNG, WebP, GIF, MP4, MOV, WebM.`,
      );
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const dir = join(this.config.mediaDir, sha256);
    mkdirSync(dir, { recursive: true });
    const originalPath = join(dir, `original.${EXT_FOR_MIME[mime] ?? 'bin'}`);
    if (!existsSync(originalPath)) await writeFile(originalPath, buf);

    const probe =
      kind === 'image' ? await this.probeImage(buf) : await this.probeVideo(originalPath);
    const id = newId();
    const now = Date.now();
    this.db
      .insert(mediaTable)
      .values({
        id,
        kind,
        sha256,
        mime,
        bytes: buf.length,
        width: probe.width,
        height: probe.height,
        durationMs: probe.durationMs,
        originalPath,
        sourcePath: opts.sourcePath ?? null,
        variants: {},
        blossomUrls: [],
        altText: opts.altText ?? null,
        createdAt: now,
      })
      .run();
    this.logger.info({ mediaId: id, kind, mime, bytes: buf.length }, 'media ingested');
    const info = this.get(id);
    return { ...info, compatibility: this.compatibility(info) };
  }

  get(id: string): MediaInfo {
    const row = this.db.select().from(mediaTable).where(eq(mediaTable.id, id)).get();
    if (!row) throw new PosterError('NOT_FOUND', `Media ${id} not found`);
    return rowToInfo(row);
  }

  getMany(ids: string[]): MediaInfo[] {
    if (ids.length === 0) return [];
    const rows = this.db.select().from(mediaTable).where(inArray(mediaTable.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, rowToInfo(r)]));
    return ids.map((id) => {
      const m = byId.get(id);
      if (!m) throw new PosterError('NOT_FOUND', `Media ${id} not found`);
      return m;
    });
  }

  summary(info: MediaInfo): MediaSummary {
    return {
      id: info.id,
      kind: info.kind,
      mime: info.mime,
      bytes: info.bytes,
      width: info.width,
      height: info.height,
      durationMs: info.durationMs,
      altText: info.altText ?? null,
    };
  }

  setAltText(id: string, altText: string | null): void {
    this.db.update(mediaTable).set({ altText }).where(eq(mediaTable.id, id)).run();
  }

  cacheBlossomUrls(id: string, urls: string[]): void {
    this.db.update(mediaTable).set({ blossomUrls: urls }).where(eq(mediaTable.id, id)).run();
  }

  /** Per-network compatibility as computed at upload time (before variant generation). */
  compatibility(info: MediaInfo): Record<string, { ok: boolean; reason?: string }> {
    const out: MediaCompatibility = {};
    const limits = this.settings.limits();
    for (const n of NETWORKS) {
      const l = limits[n];
      if (info.kind === 'video') {
        if (!l.video) out[n] = { ok: false, reason: 'video not supported' };
        else if (info.bytes > l.video.maxBytes)
          out[n] = { ok: false, reason: `over ${Math.round(l.video.maxBytes / 1048576)} MB` };
        else if ((info.durationMs ?? 0) > l.video.maxDurationMs)
          out[n] = {
            ok: false,
            reason: `longer than ${Math.round(l.video.maxDurationMs / 1000)} s`,
          };
        else out[n] = { ok: true };
      } else {
        // Images are re-encoded to fit; only "no images at all" is a hard no.
        out[n] = l.images.max > 0 ? { ok: true } : { ok: false, reason: 'images not supported' };
      }
    }
    return out as Record<string, { ok: boolean; reason?: string }>;
  }

  /* ------------------------------------------------------------------ */
  /* Variants                                                             */
  /* ------------------------------------------------------------------ */

  /** Resolve (and lazily create) the variant for a network. Returns a MediaRef ready for the adapter. */
  async variantFor(info: MediaInfo, network: Network, limits: NetworkLimits): Promise<MediaRef> {
    const row = this.db.select().from(mediaTable).where(eq(mediaTable.id, info.id)).get();
    if (!row) throw new PosterError('NOT_FOUND', `Media ${info.id} not found`);
    if (row.purgedAt)
      throw new PosterError('NOT_FOUND', `Media ${info.id} files were deleted by retention.`);

    const base = {
      id: row.id,
      kind: row.kind as MediaKind,
      sha256: row.sha256,
      altText: row.altText ?? undefined,
      blossomUrls: row.blossomUrls?.length ? row.blossomUrls : undefined,
    };

    const key = row.kind === 'video' ? 'video:h264' : `image:${network}`;
    const cached = row.variants[key];
    if (cached && existsSync(cached.path)) return { ...base, ...cached };

    const variant =
      row.kind === 'image'
        ? await this.makeImageVariant(row.originalPath, row.mime, limits)
        : await this.makeVideoVariant(row.originalPath, row.mime);
    const variants = { ...row.variants, [key]: variant };
    this.db.update(mediaTable).set({ variants }).where(eq(mediaTable.id, row.id)).run();
    return { ...base, ...variant };
  }

  private async makeImageVariant(originalPath: string, mime: string, limits: NetworkLimits) {
    const dir = join(originalPath, '..');
    const allowed = limits.images.mimes;
    // GIFs stay GIFs where allowed (animation), otherwise first frame → PNG.
    let targetMime = allowed.includes(mime)
      ? mime
      : mime === 'image/png' || mime === 'image/gif'
        ? allowed.includes('image/png')
          ? 'image/png'
          : 'image/jpeg'
        : 'image/jpeg';
    if (!allowed.includes(targetMime)) targetMime = allowed[0] ?? 'image/jpeg';

    let pipeline = sharp(originalPath, { animated: targetMime === 'image/gif' }).rotate(); // auto-orient, strips EXIF/GPS by default
    const meta = await sharp(originalPath).metadata();
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longEdge > limits.images.maxEdge) {
      pipeline = pipeline.resize({
        width: limits.images.maxEdge,
        height: limits.images.maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    let quality = 90;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      let p = pipeline.clone();
      if (scale < 1) {
        const w = Math.max(
          16,
          Math.round(Math.min(meta.width ?? limits.images.maxEdge, limits.images.maxEdge) * scale),
        );
        p = p.resize({ width: w, withoutEnlargement: true });
      }
      const out = await encode(p, targetMime, quality).toBuffer({ resolveWithObject: true });
      if (out.data.length <= limits.images.maxBytes || i === 7) {
        const ext = EXT_FOR_MIME[targetMime] ?? 'jpg';
        const path = join(
          dir,
          `${safeName(limits.text.unit)}-${limits.images.maxEdge}-${ext}.${ext}`,
        );
        await writeFile(path, out.data);
        return {
          path,
          mime: targetMime,
          bytes: out.data.length,
          width: out.info.width,
          height: out.info.height,
        };
      }
      if (targetMime === 'image/png' && i >= 1)
        targetMime = allowed.includes('image/jpeg') ? 'image/jpeg' : targetMime;
      quality = Math.max(40, quality - 12);
      if (quality <= 55) scale *= 0.8;
    }
    throw new PosterError('MEDIA_TOO_LARGE', 'Image could not be reduced below the network limit.');
  }

  private async makeVideoVariant(originalPath: string, mime: string) {
    const dir = join(originalPath, '..');
    const probe = await this.probeVideo(originalPath);
    const alreadyGood =
      mime === 'video/mp4' &&
      probe.videoCodec === 'h264' &&
      (probe.audioCodec === undefined || probe.audioCodec === 'aac');
    if (alreadyGood) {
      // Still remux with +faststart and strip metadata (cheap, no re-encode).
      const outPath = join(dir, 'h264.mp4');
      if (!existsSync(outPath)) {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-v',
            'error',
            '-i',
            originalPath,
            '-c',
            'copy',
            '-map_metadata',
            '-1',
            '-movflags',
            '+faststart',
            outPath,
          ],
          { timeout: 10 * 60_000 },
        );
      }
      const st = statSync(outPath);
      return {
        path: outPath,
        mime: 'video/mp4',
        bytes: st.size,
        width: probe.width ?? undefined,
        height: probe.height ?? undefined,
        durationMs: probe.durationMs ?? undefined,
      };
    }
    const outPath = join(dir, 'h264.mp4');
    if (!existsSync(outPath)) {
      this.logger.info({ originalPath }, 'transcoding video to H.264/AAC');
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-i',
          originalPath,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-map_metadata',
          '-1',
          '-movflags',
          '+faststart',
          outPath,
        ],
        { timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
    }
    const p2 = await this.probeVideo(outPath);
    const st = statSync(outPath);
    return {
      path: outPath,
      mime: 'video/mp4',
      bytes: st.size,
      width: p2.width ?? undefined,
      height: p2.height ?? undefined,
      durationMs: p2.durationMs ?? undefined,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Preview thumbnails                                                   */
  /* ------------------------------------------------------------------ */

  async thumbnail(id: string): Promise<Buffer> {
    const row = this.db.select().from(mediaTable).where(eq(mediaTable.id, id)).get();
    if (!row) throw new PosterError('NOT_FOUND', `Media ${id} not found`);
    if (row.purgedAt) throw new PosterError('NOT_FOUND', 'Media files were deleted by retention.');
    const thumbPath = join(row.originalPath, '..', 'thumb.jpg');
    if (existsSync(thumbPath)) return readFile(thumbPath);
    if (row.kind === 'image') {
      const buf = await sharp(row.originalPath)
        .rotate()
        .resize({ width: 480, height: 480, fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
      await writeFile(thumbPath, buf);
      return buf;
    }
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-ss',
        '00:00:01',
        '-i',
        row.originalPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:-2',
        thumbPath,
      ],
      { timeout: 60_000 },
    );
    return readFile(thumbPath);
  }

  /* ------------------------------------------------------------------ */
  /* Probing                                                              */
  /* ------------------------------------------------------------------ */

  private async probeImage(buf: Buffer): Promise<Probe> {
    try {
      const m = await sharp(buf).metadata();
      const rotated = (m.orientation ?? 1) >= 5;
      return {
        width: (rotated ? m.height : m.width) ?? null,
        height: (rotated ? m.width : m.height) ?? null,
        durationMs: null,
      };
    } catch (err) {
      throw new PosterError('MEDIA_UNSUPPORTED', 'Image could not be decoded.', { cause: err });
    }
  }

  private async probeVideo(path: string): Promise<Probe> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const json = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: {
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          duration?: string;
          side_data_list?: { rotation?: number }[];
        }[];
      };
      const v = json.streams?.find((s) => s.codec_type === 'video');
      const a = json.streams?.find((s) => s.codec_type === 'audio');
      const dur = Number(json.format?.duration ?? v?.duration ?? 0);
      const rotation =
        Math.abs(v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0) % 180;
      const w = v?.width ?? null;
      const h = v?.height ?? null;
      return {
        width: rotation === 90 ? h : w,
        height: rotation === 90 ? w : h,
        durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
        videoCodec: v?.codec_name,
        audioCodec: a?.codec_name,
      };
    } catch (err) {
      throw new PosterError(
        'MEDIA_UNSUPPORTED',
        'Video could not be probed (is ffprobe installed?).',
        { cause: err },
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Retention                                                            */
  /* ------------------------------------------------------------------ */

  /** Delete files for the given media ids; rows stay with purgedAt set. */
  purgeFiles(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      const row = this.db.select().from(mediaTable).where(eq(mediaTable.id, id)).get();
      if (!row || row.purgedAt) continue;
      const dir = join(row.originalPath, '..');
      try {
        rmSync(dir, { recursive: true, force: true });
        n++;
      } catch (err) {
        this.logger.warn({ err, id }, 'media purge failed');
      }
      this.db
        .update(mediaTable)
        .set({ purgedAt: Date.now(), variants: {} })
        .where(eq(mediaTable.id, id))
        .run();
    }
    return n;
  }

  async copyToTemp(_mediaId: string, from: string, to: string): Promise<void> {
    await copyFile(from, to);
  }
}

function rowToInfo(row: typeof mediaTable.$inferSelect): MediaInfo {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    altText: row.altText,
    createdAt: row.createdAt,
  };
}

function normaliseMime(mime: string | undefined): string | null {
  if (!mime) return null;
  if (mime === 'video/x-m4v') return 'video/mp4';
  return kindForMime(mime) ? mime : null;
}

function encode(p: sharp.Sharp, mime: string, quality: number): sharp.Sharp {
  switch (mime) {
    case 'image/png':
      return p.png({ compressionLevel: 9, palette: quality < 70 });
    case 'image/webp':
      return p.webp({ quality });
    case 'image/gif':
      return p.gif();
    default:
      return p.jpeg({ quality, mozjpeg: true });
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'v';
}

export { extname as _extname };
