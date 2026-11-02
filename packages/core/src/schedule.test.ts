import { describe, expect, it } from 'vitest';
import { resolveSchedule } from './schedule.js';
import { PosterError } from './errors.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01T12:00:00Z

describe('resolveSchedule', () => {
  it('resolves "now" immediately in the default zone', () => {
    const r = resolveSchedule('now', 'Europe/Prague', NOW);
    expect(r.immediate).toBe(true);
    expect(r.atUtcMs).toBe(NOW);
    expect(r.tz).toBe('Europe/Prague');
  });

  it('accepts ISO with offset and keeps the absolute instant', () => {
    const r = resolveSchedule('2026-11-02T09:00:00+01:00', 'Europe/Prague', NOW);
    expect(r.isoUtc).toBe('2026-11-02T08:00:00Z');
    expect(r.isoLocal).toBe('2026-11-02T09:00:00+01:00');
    expect(r.display).toContain('Mon 2 Nov 2026, 09:00');
  });

  it('reads ISO without offset in the default zone', () => {
    const r = resolveSchedule('2026-11-02T09:00', 'America/New_York', NOW);
    expect(r.isoUtc).toBe('2026-11-02T14:00:00Z');
    expect(r.tz).toBe('America/New_York');
  });

  it('accepts {at, tz}', () => {
    const r = resolveSchedule(
      { at: '2026-11-02 09:00', tz: 'America/New_York' },
      'Europe/Prague',
      NOW,
    );
    expect(r.isoUtc).toBe('2026-11-02T14:00:00Z');
    expect(r.isoLocal).toBe('2026-11-02T09:00:00-05:00');
  });

  it('rejects an unknown zone', () => {
    expect(() =>
      resolveSchedule({ at: '2026-11-02 09:00', tz: 'Mars/Olympus' }, 'Europe/Prague', NOW),
    ).toThrow(PosterError);
  });

  it('rejects the past beyond tolerance, allows within tolerance', () => {
    expect(() => resolveSchedule('2026-11-01T11:00:00Z', 'Europe/Prague', NOW)).toThrow(
      /in the past/,
    );
    const r = resolveSchedule('2026-11-01T11:59:00Z', 'Europe/Prague', NOW);
    expect(r.atUtcMs).toBe(NOW - 60_000);
  });

  it('rejects more than a year ahead', () => {
    expect(() => resolveSchedule('2027-12-01T09:00:00Z', 'Europe/Prague', NOW)).toThrow(/one year/);
  });

  it('rejects a non-existent spring-forward time with a suggestion', () => {
    // Europe/Prague: 2027-03-28 02:00 → 03:00
    const now = Date.UTC(2027, 2, 1);
    let err: PosterError | undefined;
    try {
      resolveSchedule({ at: '2027-03-28 02:30', tz: 'Europe/Prague' }, 'Europe/Prague', now);
    } catch (e) {
      err = e as PosterError;
    }
    expect(err).toBeInstanceOf(PosterError);
    expect(err?.code).toBe('SCHEDULE_INVALID');
    expect(err?.message).toMatch(/does not exist/);
    expect(err?.extra.suggestion).toBeDefined();
  });

  it('rejects an ambiguous fall-back time unless an offset is given', () => {
    // Europe/Prague: 2027-10-31 03:00 → 02:00, so 02:30 happens twice.
    const now = Date.UTC(2027, 9, 1);
    expect(() =>
      resolveSchedule({ at: '2027-10-31 02:30', tz: 'Europe/Prague' }, 'Europe/Prague', now),
    ).toThrow(/occurs twice/);
    const r = resolveSchedule('2027-10-31T02:30:00+01:00', 'Europe/Prague', now);
    expect(r.isoUtc).toBe('2027-10-31T01:30:00Z');
  });

  it('rejects garbage', () => {
    expect(() => resolveSchedule('tomorrow 9am', 'Europe/Prague', NOW)).toThrow(/Cannot parse/);
  });
});
