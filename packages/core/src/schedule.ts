import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { PosterError } from './errors.js';

export const DEFAULT_TZ = 'Europe/Prague';

/**
 * Schedule input accepted by MCP and REST:
 *  - "now"
 *  - ISO 8601 with offset: "2026-11-02T09:00:00+01:00" (or "Z")
 *  - ISO 8601 without offset: interpreted in the default zone
 *  - { at: "2026-11-02 09:00", tz: "America/New_York" }  (also "2026-11-02T09:00")
 */
export const ScheduleInputSchema = z.union([
  z.literal('now'),
  z
    .string()
    .min(1)
    .max(64)
    .describe('ISO 8601 date-time; include an offset or it is read in the default zone'),
  z.object({
    at: z.string().min(1).max(64).describe('Local date-time, e.g. "2026-11-02 09:00"'),
    tz: z.string().min(1).max(64).describe('IANA zone, e.g. "Europe/Prague"'),
  }),
]);
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export interface ResolvedSchedule {
  /** UTC instant in epoch ms. For "now" this is the resolution time. */
  atUtcMs: number;
  /** IANA zone used for display and storage. */
  tz: string;
  /** What the caller sent, verbatim, for the audit trail. */
  localInput: string;
  /** ISO in the zone, e.g. 2026-11-02T09:00:00+01:00 */
  isoLocal: string;
  /** ISO in UTC, e.g. 2026-11-02T08:00:00Z */
  isoUtc: string;
  /** Human-readable display, e.g. "Sun 2 Nov 2026, 09:00 (Europe/Prague)" */
  display: string;
  immediate: boolean;
}

export interface ScheduleRules {
  /** Tolerance for "in the past", default 2 minutes. */
  pastToleranceMs?: number;
  /** Max horizon, default 1 year. */
  maxAheadMs?: number;
}

const LOCAL_FORMATS = [
  'yyyy-MM-dd HH:mm',
  "yyyy-MM-dd'T'HH:mm",
  'yyyy-MM-dd HH:mm:ss',
  "yyyy-MM-dd'T'HH:mm:ss",
];

export function isValidZone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function resolveSchedule(
  input: ScheduleInput | undefined,
  defaultTz: string,
  nowMs: number = Date.now(),
  rules: ScheduleRules = {},
): ResolvedSchedule {
  const tzDefault = isValidZone(defaultTz) ? defaultTz : DEFAULT_TZ;
  if (input === undefined || input === 'now') {
    const dt = DateTime.fromMillis(nowMs, { zone: tzDefault });
    return toResolved(dt, tzDefault, 'now', true);
  }

  let dt: DateTime;
  let tz: string;
  let localInput: string;

  if (typeof input === 'string') {
    localInput = input;
    const parsed = DateTime.fromISO(input, { setZone: true });
    if (!parsed.isValid) {
      throw new PosterError(
        'SCHEDULE_INVALID',
        `Cannot parse date-time "${input}": ${parsed.invalidExplanation ?? parsed.invalidReason}`,
      );
    }
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input.trim());
    if (hasOffset) {
      // Absolute instant; display in the default zone.
      tz = tzDefault;
      dt = parsed.setZone(tzDefault);
    } else {
      tz = tzDefault;
      dt = parseLocal(input, tz);
    }
  } else {
    if (!isValidZone(input.tz)) {
      throw new PosterError('SCHEDULE_INVALID', `Unknown IANA time zone "${input.tz}".`);
    }
    tz = input.tz;
    localInput = `${input.at} ${input.tz}`;
    dt = parseLocal(input.at, tz);
  }

  const atUtcMs = dt.toMillis();
  const pastTol = rules.pastToleranceMs ?? 2 * 60_000;
  const maxAhead = rules.maxAheadMs ?? 366 * 24 * 3600_000;
  if (atUtcMs < nowMs - pastTol) {
    throw new PosterError('SCHEDULE_INVALID', `Scheduled time ${dt.toISO()} is in the past.`, {
      extra: { resolved: dt.toISO(), now: DateTime.fromMillis(nowMs, { zone: tz }).toISO() },
    });
  }
  if (atUtcMs > nowMs + maxAhead) {
    throw new PosterError('SCHEDULE_INVALID', 'Scheduled time is more than one year ahead.');
  }
  return toResolved(dt, tz, localInput, false);
}

function parseLocal(at: string, tz: string): DateTime {
  const s = at.trim();
  let dt: DateTime | undefined;
  for (const f of LOCAL_FORMATS) {
    const cand = DateTime.fromFormat(s, f, { zone: tz });
    if (cand.isValid) {
      dt = cand;
      break;
    }
  }
  if (!dt) {
    const iso = DateTime.fromISO(s, { zone: tz });
    if (iso.isValid) dt = iso;
  }
  if (!dt) {
    throw new PosterError(
      'SCHEDULE_INVALID',
      `Cannot parse local date-time "${at}". Use "YYYY-MM-DD HH:mm".`,
    );
  }

  // Extract requested wall clock from the input to detect DST gaps.
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi] = m;
    const requestedWall = `${y}-${mo}-${d} ${h}:${mi}`;
    const actualWall = dt.toFormat('yyyy-MM-dd HH:mm');
    if (requestedWall !== actualWall) {
      // Luxon shifted a non-existent local time (spring forward).
      throw new PosterError(
        'SCHEDULE_INVALID',
        `${requestedWall} does not exist in ${tz} (daylight-saving gap). Nearest valid time: ${actualWall}.`,
        { extra: { suggestion: dt.toISO() } },
      );
    }
    // Ambiguous (fall back): another instant has the same wall clock.
    const alt = [dt.minus({ hours: 1 }), dt.plus({ hours: 1 })].find(
      (c) => c.toFormat('yyyy-MM-dd HH:mm') === requestedWall && c.toMillis() !== dt.toMillis(),
    );
    if (alt) {
      throw new PosterError(
        'SCHEDULE_INVALID',
        `${requestedWall} occurs twice in ${tz} (daylight-saving overlap). Send an ISO time with an explicit offset: ${dt.toISO()} or ${alt.toISO()}.`,
        { extra: { candidates: [dt.toISO(), alt.toISO()] } },
      );
    }
  }
  return dt;
}

function toResolved(
  dt: DateTime,
  tz: string,
  localInput: string,
  immediate: boolean,
): ResolvedSchedule {
  const utc = dt.toUTC();
  return {
    atUtcMs: dt.toMillis(),
    tz,
    localInput,
    isoLocal: dt.toISO({ suppressMilliseconds: true }) ?? '',
    isoUtc: utc.toISO({ suppressMilliseconds: true }) ?? '',
    display: `${dt.setLocale('en-GB').toFormat('ccc d LLL yyyy, HH:mm')} (${tz})`,
    immediate,
  };
}

/** Format a stored UTC instant for display in a zone. */
export function formatInZone(
  utcMs: number,
  tz: string,
): { isoLocal: string; isoUtc: string; display: string } {
  const dt = DateTime.fromMillis(utcMs, { zone: isValidZone(tz) ? tz : DEFAULT_TZ });
  return {
    isoLocal: dt.toISO({ suppressMilliseconds: true }) ?? '',
    isoUtc: dt.toUTC().toISO({ suppressMilliseconds: true }) ?? '',
    display: `${dt.setLocale('en-GB').toFormat('ccc d LLL yyyy, HH:mm')} (${dt.zoneName})`,
  };
}
