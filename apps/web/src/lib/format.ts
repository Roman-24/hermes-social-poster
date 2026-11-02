import { DateTime } from 'luxon';

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/** Epoch ms → "2 Nov 2026, 09:00" in the browser's zone. */
export function fmtLocal(ms: number | null | undefined, zone?: string): string {
  if (ms === null || ms === undefined) return '';
  const dt = zone ? DateTime.fromMillis(ms, { zone }) : DateTime.fromMillis(ms);
  return dt.setLocale('en-GB').toFormat('d LLL yyyy, HH:mm');
}

export function fmtUtc(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  return DateTime.fromMillis(ms).toUTC().toFormat("yyyy-MM-dd HH:mm 'UTC'");
}

export function fmtRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  return DateTime.fromMillis(ms).toRelative({ locale: 'en' }) ?? '';
}

export function daysUntil(ms: number): number {
  return Math.floor((ms - Date.now()) / 86_400_000);
}

export function excerpt(text: string, n = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Default value for a datetime-local input: now + 1h in the given zone, "YYYY-MM-DDTHH:mm". */
export function defaultLocalDateTime(zone: string): string {
  const dt = DateTime.now().setZone(zone).plus({ hours: 1 }).startOf('hour');
  return dt.toFormat("yyyy-MM-dd'T'HH:mm");
}

export function timeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
}
