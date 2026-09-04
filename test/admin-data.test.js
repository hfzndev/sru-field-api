import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as browseData } from '@/app/api/admin/data/route';
import { GET as exportData } from '@/app/api/admin/data/export/route';
import { fetchFieldData } from '@/lib/admin-data';
import { SESSION_COOKIE, createSession } from '@/lib/session';
import {
  cleanupTempDbs, seedAdmin, seedShiftAccount, seedTanks, useTempDb,
} from './helpers/seed.js';

/**
 * Date filtering for Data Lapangan and the CSV export (doc 06 §6).
 *
 * This file exists because there was none, and its absence is exactly how the
 * cleaning date filter shipped broken: the three record types filter on three
 * different columns, and two of those columns hold ISO while the third holds
 * SQLite's space-separated form. Text-comparing an ISO bound against a
 * SQLite-format column silently drops the whole `from` day — a 200 and an empty
 * list, which an admin reads as "there was no cleaning that day".
 *
 * So the cases that matter most here are the boundary ones: a row timestamped
 * on the `from` date itself, for every record type.
 */

const BASE = 'http://localhost';

let db;
let cookie;
let tanks;

beforeEach(() => {
  db = useTempDb();
  process.env.SESSION_SECRET = 'a'.repeat(64);
  seedAdmin(db);
  seedShiftAccount(db);
  tanks = seedTanks(db);
  cookie = { cookie: `${SESSION_COOKIE}=${createSession('admin')}` };
});
afterAll(cleanupTempDbs);

/* --------------------------------------------------------------- fixtures */

/**
 * Rows are inserted with explicit timestamps in each column's REAL storage
 * format, not through sync — the point is to pin the formats the filters must
 * cope with, and going through sync would hide them behind normalisation.
 */
function seedReading(readingAt, shiftGroup = 'Shift A') {
  return db.prepare(`
    INSERT INTO tank_readings
      (client_id, tank_id, tape_length_mm, bandul_sulfur_mm, level_mm,
       operator_name, shift_group, shift_time, reading_at)
    VALUES (?, ?, 2901, 35, 5087, 'Budi', ?, 'pagi', ?)
  `).run(randomUUID(), tanks.t401, shiftGroup, readingAt).lastInsertRowid;
}

function seedActivity(activityAt, shiftGroup = 'Shift A') {
  return db.prepare(`
    INSERT INTO activity_logs
      (client_id, type, description, activity_at, operator_name, shift_group, shift_time)
    VALUES (?, 'OPERATOR', 'buka valve drain', ?, 'Budi', ?, 'pagi')
  `).run(randomUUID(), activityAt, shiftGroup).lastInsertRowid;
}

/** created_at is SQLite-format — the column the bug lived on. */
function seedCleaning(createdAt, shiftGroup = 'Shift A') {
  return db.prepare(`
    INSERT INTO cleaning_sessions
      (client_id, location, status, operator_name, shift_group, shift_time, created_at)
    VALUES (?, 'lantai area U-93', 'DONE', 'Budi', ?, 'pagi', ?)
  `).run(randomUUID(), shiftGroup, createdAt).lastInsertRowid;
}

const q = (params) => ({ shiftGroup: '', shiftTime: '', from: '', to: '', limit: 500, ...params });

/* ------------------------------------------------- the boundary that broke */

describe('the from-date boundary', () => {
  it('includes cleaning recorded on the from date itself', () => {
    // The reproduced bug: both rows sit on 3 Sep, and a 3 Sep filter returned
    // nothing because '2026-09-03 18:33:35' < '2026-09-03T00:00:00.000Z'.
    seedCleaning('2026-09-03 18:33:35');
    seedCleaning('2026-09-03 19:14:44');

    const rows = fetchFieldData(db, q({ type: 'cleaning', from: '2026-09-03', to: '2026-09-03' }));
    expect(rows).toHaveLength(2);
  });

  it('includes a row at the very first second of the from date', () => {
    seedCleaning('2026-09-03 00:00:00');
    expect(fetchFieldData(db, q({ type: 'cleaning', from: '2026-09-03' }))).toHaveLength(1);
  });

  it('includes a row at the very last second of the to date', () => {
    seedCleaning('2026-09-03 23:59:59');
    expect(fetchFieldData(db, q({ type: 'cleaning', from: '2026-09-03', to: '2026-09-03' }))).toHaveLength(1);
  });

  it('still excludes the days either side', () => {
    seedCleaning('2026-09-02 23:59:59');
    seedCleaning('2026-09-03 12:00:00');
    seedCleaning('2026-09-04 00:00:00');

    const rows = fetchFieldData(db, q({ type: 'cleaning', from: '2026-09-03', to: '2026-09-03' }));
    expect(rows).toHaveLength(1);
  });

  it('holds for readings and activities too, on their ISO columns', () => {
    seedReading('2026-09-03T00:00:00.000Z');
    seedActivity('2026-09-03T00:00:00.000Z');

    expect(fetchFieldData(db, q({ type: 'readings', from: '2026-09-03', to: '2026-09-03' }))).toHaveLength(1);
    expect(fetchFieldData(db, q({ type: 'activities', from: '2026-09-03', to: '2026-09-03' }))).toHaveLength(1);
  });
});

/* ------------------------------------------------------- the three shapes */

describe.each([
  ['readings', seedReading, '2026-09-03T10:00:00.000Z', '2026-09-02T10:00:00.000Z'],
  ['activities', seedActivity, '2026-09-03T10:00:00.000Z', '2026-09-02T10:00:00.000Z'],
  ['cleaning', seedCleaning, '2026-09-03 10:00:00', '2026-09-02 10:00:00'],
])('%s date filtering', (type, seed, onDay, dayBefore) => {
  beforeEach(() => {
    seed(onDay);
    seed(dayBefore);
  });

  it('from only — keeps that day and later', () => {
    expect(fetchFieldData(db, q({ type, from: '2026-09-03' }))).toHaveLength(1);
  });

  it('to only — keeps that day and earlier', () => {
    expect(fetchFieldData(db, q({ type, to: '2026-09-03' }))).toHaveLength(2);
  });

  it('both — keeps only the range', () => {
    expect(fetchFieldData(db, q({ type, from: '2026-09-02', to: '2026-09-02' }))).toHaveLength(1);
  });

  it('neither — keeps everything', () => {
    expect(fetchFieldData(db, q({ type }))).toHaveLength(2);
  });

  it('combines with a shift filter', () => {
    seed(onDay, 'Shift B');
    const rows = fetchFieldData(db, q({ type, from: '2026-09-03', shiftGroup: 'Shift A' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].shiftGroup).toBe('Shift A');
  });
});

/* ------------------------------------------------------------ the routes */

describe('the routes agree with each other', () => {
  function get(url) {
    return new Request(`${BASE}${url}`, { headers: cookie });
  }

  beforeEach(() => {
    seedCleaning('2026-09-03 18:33:35');
    seedCleaning('2026-09-03 19:14:44');
    seedCleaning('2026-09-01 10:00:00');
  });

  it('GET /api/admin/data returns the filtered rows', async () => {
    const response = await browseData(get('/api/admin/data?type=cleaning&from=2026-09-03&to=2026-09-03'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.count).toBe(2);
  });

  it('the CSV export matches what the screen showed', async () => {
    // The export is the sanctioned route for field data to leave this system
    // (doc 04 §8), so a filter that disagrees with the screen is a compliance
    // problem, not a display bug.
    const url = '?type=cleaning&from=2026-09-03&to=2026-09-03';
    const onScreen = await (await browseData(get(`/api/admin/data${url}`))).json();
    const csv = await (await exportData(get(`/api/admin/data/export${url}`))).text();

    const dataRows = csv.trim().split('\n').length - 1; // minus the header
    expect(dataRows).toBe(onScreen.count);
    expect(dataRows).toBe(2);
  });

  it('records the export in the audit trail', async () => {
    await exportData(get('/api/admin/data/export?type=cleaning&from=2026-09-03&to=2026-09-03'));
    const action = db.prepare("SELECT * FROM admin_actions WHERE action = 'EXPORT'").get();
    expect(action.entity).toBe('cleaning');
    expect(action.detail).toContain('2 baris');
  });

  it('needs an admin session', async () => {
    const response = await browseData(new Request(`${BASE}/api/admin/data?type=cleaning`));
    expect(response.status).toBe(401);
  });
});
