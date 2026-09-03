import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as syncRoute } from '@/app/api/sync/route';
import { POST as login } from '@/app/api/auth/login/route';
import { currentDataVersion } from '@/lib/dataversion';
import { processSync } from '@/lib/sync';
import { parse, syncSchema } from '@/lib/validation';
import {
  TEST_PASSWORD,
  cleanupTempDbs,
  postRequest,
  seedEquipment,
  seedShiftAccount,
  seedTanks,
  seedTask,
  useTempDb,
  withBearer,
} from './helpers/seed.js';

const SYNC_URL = 'http://localhost/api/sync';

let db;
let tanks;

beforeEach(() => {
  db = useTempDb();
  seedShiftAccount(db);
  tanks = seedTanks(db);
});
afterAll(cleanupTempDbs);

const uuid = () => randomUUID();

/** The worked example from doc 02 §2.1: 7953 − 2901 + 35 = 5087, dev +87. */
function reading(overrides = {}) {
  return {
    clientId: uuid(),
    tankId: tanks.t401,
    dcsLevelMm: 5000,
    tapeLengthMm: 2901,
    bandulSulfurMm: 35,
    attempts: 2,
    operatorName: 'Budi',
    shiftGroup: 'Shift A',
    shiftTime: 'pagi',
    readingAt: '2026-09-02T01:10:00.000Z',
    ...overrides,
  };
}

function cleaning(overrides = {}) {
  return {
    clientId: uuid(),
    location: 'lantai area U-93 dekat kolom A',
    operatorName: 'Budi',
    shiftGroup: 'Shift A',
    shiftTime: 'pagi',
    beforePhoto: 'uploads/' + 'a'.repeat(32) + '.jpg',
    beforePhotoAt: '2026-09-02T01:00:00.000Z',
    ...overrides,
  };
}

function activity(overrides = {}) {
  return {
    clientId: uuid(),
    type: 'OPERATOR',
    description: 'buka valve drain kolom A',
    activityAt: '2026-09-02T02:00:00.000Z',
    operatorName: 'Budi',
    shiftGroup: 'Shift A',
    shiftTime: 'pagi',
    ...overrides,
  };
}

function payload(parts = {}) {
  return { readings: [], cleaning: [], activities: [], taskLogs: [], ...parts };
}

/**
 * Runs the engine on the same path the route uses — through zod first, then
 * processSync — just without auth. Calling processSync with raw fixtures would
 * skip schema defaults and test a payload shape the route can never produce.
 */
function sync(parts) {
  const parsed = parse(syncSchema, payload(parts));
  if (!parsed.ok) {
    throw new Error(`fixture failed validation: ${JSON.stringify(parsed.details)}`);
  }
  return processSync(db, parsed.data);
}

/* ------------------------------------------------------------------ readings */

describe('readings', () => {
  it('recomputes the level server-side and returns it in the ack', () => {
    const result = sync({ readings: [reading()] });

    expect(result.errors).toEqual([]);
    expect(result.acked).toHaveLength(1);
    expect(result.acked[0].levelMm).toBe(5087);
    expect(result.acked[0].deviationMm).toBe(87);

    const row = db.prepare('SELECT * FROM tank_readings').get();
    expect(row.level_mm).toBe(5087);
    expect(row.deviation_mm).toBe(87);
    expect(row.attempts).toBe(2);
  });

  it('ignores a level the client tries to supply', () => {
    // levelMm is not in the schema, so zod strips it — the phone cannot assert
    // a level even by accident (doc 04 §3.2).
    sync({ readings: [reading({ levelMm: 9999, deviationMm: -1 })] });
    const row = db.prepare('SELECT level_mm, deviation_mm FROM tank_readings').get();
    expect(row.level_mm).toBe(5087);
    expect(row.deviation_mm).toBe(87);
  });

  it('stores a null deviation when DCS was unreadable', () => {
    sync({ readings: [reading({ dcsLevelMm: null })] });
    const row = db.prepare('SELECT deviation_mm FROM tank_readings').get();
    expect(row.deviation_mm).toBeNull();
  });

  it('uses the right height for each tank', () => {
    sync({ readings: [reading({ tankId: tanks.t402 })] });
    // 7974 − 2901 + 35
    expect(db.prepare('SELECT level_mm FROM tank_readings').get().level_mm).toBe(5108);
  });

  it('rejects a bandul reading of 100 without touching the others', () => {
    const result = sync({
      readings: [reading(), reading({ bandulSulfurMm: 100 }), reading(), reading()],
    });

    expect(result.acked).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error.code).toBe('BANDUL_OUT_OF_RANGE');
    expect(db.prepare('SELECT COUNT(*) n FROM tank_readings').get().n).toBe(3);
  });

  it('rejects a tape at or beyond the tank floor', () => {
    const result = sync({ readings: [reading({ tapeLengthMm: 7953 })] });
    expect(result.errors[0].error.code).toBe('TAPE_TOO_LONG');
  });

  it('rejects a reading for a tank that does not exist', () => {
    const result = sync({ readings: [reading({ tankId: 9999 })] });
    expect(result.errors[0].error.code).toBe('TANK_NOT_FOUND');
  });

  it('rejects a reading for a deactivated tank', () => {
    db.prepare('UPDATE tanks SET is_active = 0 WHERE id = ?').run(tanks.t401);
    const result = sync({ readings: [reading()] });
    expect(result.errors[0].error.code).toBe('TANK_NOT_FOUND');
  });
});

/* -------------------------------------------------------------- idempotency */

describe('idempotency (doc 07 §3)', () => {
  it('a replayed batch inserts nothing and reports duplicates — S2', () => {
    const batch = [reading(), reading(), reading(), reading(), reading()];

    const first = sync({ readings: batch });
    expect(first.acked).toHaveLength(5);

    const second = sync({ readings: batch });
    expect(second.acked).toHaveLength(0);
    expect(second.duplicates).toHaveLength(5);
    expect(db.prepare('SELECT COUNT(*) n FROM tank_readings').get().n).toBe(5);
  });

  it('reports the original serverId for a duplicate so the phone can map it', () => {
    const record = reading();
    const first = sync({ readings: [record] });
    const second = sync({ readings: [record] });
    expect(second.duplicates[0].serverId).toBe(first.acked[0].serverId);
  });

  it('never updates an existing record from a replayed payload (doc 10 §2.12)', () => {
    // Only cleaning may be updated after insert. A reading re-sent with
    // different numbers must leave the stored row exactly as it was.
    const record = reading();
    sync({ readings: [record] });
    const result = sync({ readings: [{ ...record, tapeLengthMm: 1000, bandulSulfurMm: 10 }] });

    expect(result.duplicates).toHaveLength(1);
    const row = db.prepare('SELECT tape_length_mm, level_mm FROM tank_readings').get();
    expect(row.tape_length_mm).toBe(2901);
    expect(row.level_mm).toBe(5087);
  });

  it('holds for activities and task logs too', () => {
    const equipmentId = seedEquipment(db);
    const taskId = seedTask(db, equipmentId);
    const act = activity();
    const log = { clientId: uuid(), taskId, newStatus: 'IN_PROGRESS', progressPct: 50, operatorName: 'Budi' };

    sync({ activities: [act], taskLogs: [log] });
    const second = sync({ activities: [act], taskLogs: [log] });

    expect(second.duplicates).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) n FROM activity_logs').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM maintenance_task_logs').get().n).toBe(1);
  });
});

/* ---------------------------------------------------------------- activities */

describe('activities', () => {
  it('requires a contractor name for KONTRAKTOR work', () => {
    const result = sync({ activities: [activity({ type: 'KONTRAKTOR' })] });
    expect(result.errors[0].error.code).toBe('CONTRACTOR_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) n FROM activity_logs').get().n).toBe(0);
  });

  it('treats a whitespace-only contractor name as missing', () => {
    const result = sync({ activities: [activity({ type: 'KONTRAKTOR', contractorName: '   ' })] });
    expect(result.errors[0].error.code).toBe('CONTRACTOR_REQUIRED');
  });

  it('accepts KONTRAKTOR work with a name', () => {
    sync({
      activities: [activity({
        type: 'KONTRAKTOR',
        contractorName: 'PT Tejo Lomanis',
        description: 'pengecatan kompresor',
        unitArea: 'Unit 91',
      })],
    });
    const row = db.prepare('SELECT * FROM activity_logs').get();
    expect(row.contractor_name).toBe('PT Tejo Lomanis');
    expect(row.unit_area).toBe('Unit 91');
  });

  it('strips a contractor name from OPERATOR work rather than rejecting it (doc 10 §2.4)', () => {
    const result = sync({ activities: [activity({ contractorName: 'PT Salah Isi' })] });
    expect(result.acked).toHaveLength(1);
    expect(db.prepare('SELECT contractor_name FROM activity_logs').get().contractor_name).toBe('');
  });
});

/* ------------------------------------------------------------------ cleaning */

describe('cleaning two-stage upsert (doc 06 §5, S10)', () => {
  it('starts IN_PROGRESS with only a before photo', () => {
    sync({ cleaning: [cleaning()] });
    const row = db.prepare('SELECT * FROM cleaning_sessions').get();
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.after_photo).toBe('');
  });

  it('completes the same row when the after photo arrives — one row, not two', () => {
    const session = cleaning();
    const first = sync({ cleaning: [session] });

    const completed = {
      ...session,
      afterPhoto: 'uploads/' + 'b'.repeat(32) + '.jpg',
      afterPhotoAt: '2026-09-02T03:00:00.000Z',
    };
    const second = sync({ cleaning: [completed] });

    expect(second.acked).toHaveLength(1);
    expect(second.acked[0].updated).toBe(true);
    expect(second.acked[0].serverId).toBe(first.acked[0].serverId);

    expect(db.prepare('SELECT COUNT(*) n FROM cleaning_sessions').get().n).toBe(1);
    const row = db.prepare('SELECT * FROM cleaning_sessions').get();
    expect(row.status).toBe('DONE');
    expect(row.after_photo).toBe(completed.afterPhoto);
    expect(row.before_photo).toBe(session.beforePhoto);
  });

  it('treats a replay of the completed session as a duplicate — Sync stays safe to press', () => {
    const session = cleaning();
    sync({ cleaning: [session] });
    const completed = { ...session, afterPhoto: 'uploads/' + 'b'.repeat(32) + '.jpg' };
    sync({ cleaning: [completed] });

    const third = sync({ cleaning: [completed] });
    expect(third.acked).toHaveLength(0);
    expect(third.duplicates).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) n FROM cleaning_sessions').get().n).toBe(1);
  });

  it('ignores attempts to change immutable fields during the upsert', () => {
    const session = cleaning();
    sync({ cleaning: [session] });

    sync({
      cleaning: [{
        ...session,
        afterPhoto: 'uploads/' + 'b'.repeat(32) + '.jpg',
        location: 'lokasi diubah',
        beforePhoto: 'uploads/' + 'c'.repeat(32) + '.jpg',
        operatorName: 'Orang Lain',
        shiftGroup: 'Shift D',
      }],
    });

    const row = db.prepare('SELECT * FROM cleaning_sessions').get();
    expect(row.location).toBe(session.location);
    expect(row.before_photo).toBe(session.beforePhoto);
    expect(row.operator_name).toBe('Budi');
    expect(row.shift_group).toBe('Shift A');
  });

  it('records DONE immediately when both photos arrive at once', () => {
    sync({ cleaning: [cleaning({ afterPhoto: 'uploads/' + 'b'.repeat(32) + '.jpg' })] });
    expect(db.prepare('SELECT status FROM cleaning_sessions').get().status).toBe('DONE');
  });

  it('derives status from the after photo rather than trusting the client', () => {
    // A session cannot be declared complete without evidence.
    sync({ cleaning: [cleaning({ status: 'DONE' })] });
    expect(db.prepare('SELECT status FROM cleaning_sessions').get().status).toBe('IN_PROGRESS');
  });

  it('does not resurrect a session by clearing its after photo', () => {
    const session = cleaning();
    sync({ cleaning: [session] });
    sync({ cleaning: [{ ...session, afterPhoto: 'uploads/' + 'b'.repeat(32) + '.jpg' }] });

    sync({ cleaning: [{ ...session, afterPhoto: '' }] });
    expect(db.prepare('SELECT status FROM cleaning_sessions').get().status).toBe('DONE');
  });
});

/* ----------------------------------------------------------------- task logs */

describe('task logs', () => {
  let taskId;
  beforeEach(() => { taskId = seedTask(db, seedEquipment(db)); });

  function taskLog(overrides = {}) {
    return {
      clientId: uuid(), taskId, newStatus: 'IN_PROGRESS', progressPct: 50,
      note: 'bongkar housing', operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      ...overrides,
    };
  }

  it('updates the parent task in the same transaction', () => {
    sync({ taskLogs: [taskLog()] });
    const task = db.prepare('SELECT status, progress_pct FROM maintenance_tasks WHERE id = ?').get(taskId);
    expect(task.status).toBe('IN_PROGRESS');
    expect(task.progress_pct).toBe(50);
  });

  it('reads old_status from the database, not from the client', () => {
    sync({ taskLogs: [taskLog()] });
    expect(db.prepare('SELECT old_status FROM maintenance_task_logs').get().old_status).toBe('OPEN');

    sync({ taskLogs: [taskLog({ newStatus: 'DONE', progressPct: 100 })] });
    const logs = db.prepare('SELECT old_status, new_status FROM maintenance_task_logs ORDER BY id').all();
    expect(logs[1].old_status).toBe('IN_PROGRESS');
    expect(logs[1].new_status).toBe('DONE');
  });

  it('keeps every log as history while the task carries current state', () => {
    sync({ taskLogs: [taskLog({ progressPct: 25 })] });
    sync({ taskLogs: [taskLog({ progressPct: 75 })] });

    expect(db.prepare('SELECT COUNT(*) n FROM maintenance_task_logs').get().n).toBe(2);
    expect(db.prepare('SELECT progress_pct FROM maintenance_tasks WHERE id = ?').get(taskId).progress_pct).toBe(75);
  });

  it('bumps and stamps dataVersion so other phones see the task move', () => {
    // maintenance_tasks is master data pulled by delta (doc 07 §7). Without the
    // stamp the update would be invisible to the other two devices.
    const before = currentDataVersion(db);
    sync({ taskLogs: [taskLog()] });
    const after = currentDataVersion(db);

    expect(after).toBeGreaterThan(before);
    expect(db.prepare('SELECT data_version FROM maintenance_tasks WHERE id = ?').get(taskId).data_version).toBe(after);
  });

  it('leaves the task untouched for a note-only log', () => {
    sync({ taskLogs: [taskLog({ newStatus: null, progressPct: null, note: 'menunggu spare part' })] });
    const task = db.prepare('SELECT status, progress_pct FROM maintenance_tasks WHERE id = ?').get(taskId);
    expect(task.status).toBe('OPEN');
    expect(task.progress_pct).toBe(0);
    expect(currentDataVersion(db)).toBe(0);
  });

  it('rejects a log for a task that does not exist', () => {
    const result = sync({ taskLogs: [taskLog({ taskId: 9999 })] });
    expect(result.errors[0].error.code).toBe('TASK_NOT_FOUND');
  });
});

/* --------------------------------------------------------------- dataVersion */

describe('dataVersion scope', () => {
  it('is untouched by field data (doc 06 §5)', () => {
    // Readings, activities and cleaning are pulled by the 7-day window, not by
    // the master delta — bumping for them would force pointless full pulls.
    seedEquipment(db);
    sync({
      readings: [reading()],
      activities: [activity()],
      cleaning: [cleaning()],
    });
    expect(currentDataVersion(db)).toBe(0);
  });
});

/* ------------------------------------------------------- route-level concerns */

describe('POST /api/sync', () => {
  async function authedToken() {
    const response = await login(postRequest('http://localhost/api/auth/login', {
      username: 'shift_a', password: TEST_PASSWORD, deviceName: 'HP-1', appVersion: '1.0.0',
    }));
    return (await response.json()).token;
  }

  it('requires a device token', async () => {
    const response = await syncRoute(postRequest(SYNC_URL, payload({ readings: [reading()] })));
    expect(response.status).toBe(401);
  });

  it('accepts an authenticated batch', async () => {
    const token = await authedToken();
    const response = await syncRoute(postRequest(SYNC_URL, payload({ readings: [reading()] }), withBearer(token)));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acked).toHaveLength(1);
    expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('rejects a clientId that is not a UUID v4 (doc 10 §2.2)', async () => {
    const token = await authedToken();
    const response = await syncRoute(
      postRequest(SYNC_URL, payload({ readings: [reading({ clientId: 'not-a-uuid' })] }), withBearer(token)),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.details.some((d) => d.field.includes('clientId'))).toBe(true);
  });

  it('rejects a wholly empty payload', async () => {
    const token = await authedToken();
    const response = await syncRoute(postRequest(SYNC_URL, payload(), withBearer(token)));
    expect(response.status).toBe(400);
  });

  it('rejects a timestamp more than 24 hours in the future', async () => {
    const token = await authedToken();
    const future = new Date(Date.now() + 48 * 3600_000).toISOString();
    const response = await syncRoute(
      postRequest(SYNC_URL, payload({ readings: [reading({ readingAt: future })] }), withBearer(token)),
    );
    expect(response.status).toBe(400);
  });

  it('accepts a timestamp slightly ahead, tolerating phone clock drift', async () => {
    const token = await authedToken();
    const soon = new Date(Date.now() + 60_000).toISOString();
    const response = await syncRoute(
      postRequest(SYNC_URL, payload({ readings: [reading({ readingAt: soon })] }), withBearer(token)),
    );
    expect(response.status).toBe(200);
  });

  it('enforces the text length caps from doc 08 §5', async () => {
    const token = await authedToken();
    const response = await syncRoute(
      postRequest(SYNC_URL, payload({ activities: [activity({ description: 'x'.repeat(501) })] }), withBearer(token)),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a photo path the upload endpoint could not have produced', async () => {
    // Blocks a crafted path reaching the database and later the photo endpoint.
    const token = await authedToken();
    const response = await syncRoute(
      postRequest(SYNC_URL, payload({ readings: [reading({ photoPath: '../../etc/passwd' })] }), withBearer(token)),
    );
    expect(response.status).toBe(400);
  });

  it('returns 200 with a mix of acks and errors — a bad record never fails the batch', async () => {
    const token = await authedToken();
    const response = await syncRoute(postRequest(SYNC_URL, payload({
      readings: [reading(), reading({ bandulSulfurMm: 100 })],
      activities: [activity(), activity({ type: 'KONTRAKTOR' })],
    }), withBearer(token)));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acked).toHaveLength(2);
    expect(body.errors).toHaveLength(2);
  });
});
