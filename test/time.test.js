import { describe, expect, it } from 'vitest';
import { isoToSqlite, nowIso, sqliteDaysAgo, toIso } from '@/lib/time';

describe('toIso', () => {
  it('converts SQLite datetime(now) output to ISO-8601 UTC', () => {
    // The stored form is UTC but lacks T and Z, which some engines parse as
    // local time — that would shift every field record by the WIB offset.
    expect(toIso('2026-09-02 17:53:46')).toBe('2026-09-02T17:53:46.000Z');
  });

  it('normalises a value already stored as ISO', () => {
    expect(toIso('2026-09-02T01:10:00.000Z')).toBe('2026-09-02T01:10:00.000Z');
    expect(toIso('2026-09-02T08:10:00+07:00')).toBe('2026-09-02T01:10:00.000Z');
  });

  it('returns null for empty values', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('')).toBeNull();
  });

  it('passes unparseable text through rather than discarding it', () => {
    // Losing an operator's timestamp is worse than surfacing an odd one.
    expect(toIso('not a date')).toBe('not a date');
  });
});

describe('isoToSqlite', () => {
  it('produces the storage format used by datetime(now)', () => {
    expect(isoToSqlite('2026-09-02T17:53:46.000Z')).toBe('2026-09-02 17:53:46');
  });

  it('converts an offset timestamp to UTC first', () => {
    expect(isoToSqlite('2026-09-03T00:53:46+07:00')).toBe('2026-09-02 17:53:46');
  });

  it('throws on garbage instead of producing a silently wrong window', () => {
    expect(() => isoToSqlite('nope')).toThrow(TypeError);
  });

  it('round-trips with toIso', () => {
    const stored = '2026-09-02 17:53:46';
    expect(isoToSqlite(toIso(stored))).toBe(stored);
  });

  it('is directly comparable with stored timestamps as strings', () => {
    // SQLite compares these as text, so format agreement is what makes
    // "received_at >= ?" correct. Mixed formats compare on the space-vs-T byte.
    const earlier = isoToSqlite('2026-09-01T00:00:00.000Z');
    const later = isoToSqlite('2026-09-02T00:00:00.000Z');
    expect(earlier < later).toBe(true);
    expect(earlier < '2026-09-01 12:00:00').toBe(true);
  });
});

describe('sqliteDaysAgo', () => {
  it('computes the 7-day pull window in storage format', () => {
    const from = new Date('2026-09-10T00:00:00.000Z');
    expect(sqliteDaysAgo(7, from)).toBe('2026-09-03 00:00:00');
  });
});

describe('nowIso', () => {
  it('returns a parseable ISO-8601 UTC string', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
