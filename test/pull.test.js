import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as pullRoute } from '@/app/api/pull/route';
import { POST as login } from '@/app/api/auth/login/route';
import { currentDataVersion, stampMaster } from '@/lib/dataversion';
import { buildPull, parseSince } from '@/lib/pull';
import { processSync } from '@/lib/sync';
import { parse, syncSchema } from '@/lib/validation';
import {
  TEST_PASSWORD,
  cleanupTempDbs,
  postRequest,
  seedContractor,
  seedCrew,
  seedEquipment,
  seedShiftAccount,
  seedTanks,
  seedTask,
  useTempDb,
  withBearer,
} from './helpers/seed.js';

let db;
let accountA;
let tanks;

const ACCOUNT_A = { id: null, code: 'SHIFT_A', displayName: 'Shift A' };

beforeEach(() => {
  db = useTempDb();
  accountA = seedShiftAccount(db);
  ACCOUNT_A.id = accountA;
  tanks = seedTanks(db);
});
afterAll(cleanupTempDbs);

const pull = (since = 0, account = ACCOUNT_A) => buildPull(db, account, since);

function totalMasterRows(result) {
  const { tanks: t, equipment, contractors, tasks, crew } = result.master;
  return t.length + equipment.length + contractors.length + tasks.length + crew.length;
}

/**
 * Inserts field data through the real sync path so attribution is realistic.
 *
 * `shiftGroup` is the authenticated account, which is what actually decides the
 * stored shift_group -- the value inside each fixture is ignored, exactly as it
 * is for a real handset.
 */
function syncAs(shiftGroup, parts) {
  const base = { readings: [], cleaning: [], activities: [], taskLogs: [], equipmentStatus: [] };
  const parsed = parse(syncSchema, { ...base, ...parts });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.details));
  return processSync(db, parsed.data, { displayName: shiftGroup });
}

function reading(shiftGroup, overrides = {}) {
  return {
    clientId: randomUUID(),
    tankId: tanks.t401,
    dcsLevelMm: 5000,
    tapeLengthMm: 2901,
    bandulSulfurMm: 35,
    operatorName: 'Budi',
    shiftGroup,
    shiftTime: 'pagi',
    readingAt: '2026-09-02T01:10:00.000Z',
    ...overrides,
  };
}

/* ------------------------------------------------------------- since cursor */

describe('parseSince', () => {
  it('reads a valid cursor', () => {
    expect(parseSince('12')).toBe(12);
  });

  it('falls back to a full sync rather than erroring on a corrupt cursor', () => {
    // A phone with a damaged cursor should recover by resyncing, not be locked
    // out of pulling entirely.
    for (const value of [null, undefined, '', 'abc', '-5', 'NaN']) {
      expect(parseSince(value)).toBe(0);
    }
  });

  it('truncates a fractional cursor', () => {
    expect(parseSince('12.9')).toBe(12);
  });
});

/* -------------------------------------------------------------- master delta */

/**
 * Seed helpers insert rows directly, leaving data_version at 0. In a real
 * database every master row arrives through admin CRUD and is stamped, so the
 * delta tests must start from that state — otherwise `since` is 0, the initial
 * branch runs, and the delta path is never actually exercised.
 */
function stampEverything() {
  for (const table of ['tanks', 'equipment', 'contractors', 'shift_accounts', 'shift_crew', 'maintenance_tasks']) {
    for (const row of db.prepare(`SELECT id FROM ${table}`).all()) {
      stampMaster(db, table, row.id);
    }
  }
}

describe('master delta (doc 10 §2.10 — the regression guard)', () => {
  beforeEach(() => {
    seedCrew(db, accountA, ['Budi', 'Slamet']);
    seedContractor(db, 'PT Tejo Lomanis');
    seedContractor(db, 'PT Kedua');
    seedTask(db, seedEquipment(db));
    stampEverything();
  });

  it('sends everything active on the initial pull (since=0)', () => {
    const result = pull(0);
    expect(result.master.tanks).toHaveLength(2);
    expect(result.master.contractors).toHaveLength(2);
    expect(result.master.crew).toHaveLength(2);
    expect(result.master.tasks).toHaveLength(1);
  });

  it('returns exactly one row after one master change — not the whole master', () => {
    // This is the test that catches `updated_at > since`: with TEXT compared to
    // INTEGER the clause is always true and every pull silently ships the full
    // master over a 2G link.
    const before = currentDataVersion(db);
    const contractorId = db.prepare("SELECT id FROM contractors WHERE name = 'PT Kedua'").get().id;
    db.prepare("UPDATE contractors SET name = 'PT Kedua Baru' WHERE id = ?").run(contractorId);
    stampMaster(db, 'contractors', contractorId);

    const result = pull(before);
    expect(totalMasterRows(result)).toBe(1);
    expect(result.master.contractors[0].name).toBe('PT Kedua Baru');
  });

  it('returns nothing when the cursor is current', () => {
    const result = pull(currentDataVersion(db));
    expect(totalMasterRows(result)).toBe(0);
  });

  it('advances the cursor it hands back', () => {
    const first = pull(0);
    const contractorId = seedContractor(db, 'PT Ketiga');
    stampMaster(db, 'contractors', contractorId);

    const second = pull(first.dataVersion);
    expect(second.dataVersion).toBeGreaterThan(first.dataVersion);
    expect(second.master.contractors).toHaveLength(1);
  });

  it('never reports a cursor ahead of the rows it just sent', () => {
    // dataVersion is read before the queries. Reading it after would let a
    // concurrent mutation land in between, and the phone would store a cursor
    // above a row it never received — losing that row permanently.
    const contractorId = seedContractor(db, 'PT Keempat');
    stampMaster(db, 'contractors', contractorId);

    const result = pull(0);
    const stamped = db.prepare('SELECT data_version FROM contractors WHERE id = ?').get(contractorId);
    expect(result.dataVersion).toBeGreaterThanOrEqual(stamped.data_version);
  });

  it('propagates a soft delete so the phone can prune its quick-pick', () => {
    // Filtering the delta to is_active=1 would make deactivation invisible and
    // a removed contractor would linger on the handset forever.
    const before = currentDataVersion(db);
    const contractorId = db.prepare("SELECT id FROM contractors WHERE name = 'PT Kedua'").get().id;
    db.prepare('UPDATE contractors SET is_active = 0 WHERE id = ?').run(contractorId);
    stampMaster(db, 'contractors', contractorId);

    const result = pull(before);
    expect(result.master.contractors).toHaveLength(1);
    expect(result.master.contractors[0].isActive).toBe(false);
  });

  it('omits inactive rows from an initial pull', () => {
    const contractorId = seedContractor(db, 'PT Sudah Habis', 0);
    stampMaster(db, 'contractors', contractorId);

    const names = pull(0).master.contractors.map((c) => c.name);
    expect(names).not.toContain('PT Sudah Habis');
  });

  it('scopes crew to the calling shift', () => {
    const accountB = seedShiftAccount(db, { code: 'SHIFT_B', displayName: 'Shift B' });
    seedCrew(db, accountB, ['Joko']);

    expect(pull(0).master.crew.map((c) => c.name)).toEqual(['Budi', 'Slamet']);
  });
});

/* ------------------------------------------------------------ recent window */

describe('recent window (doc 10 §2.8)', () => {
  it('returns the calling shift’s own records', () => {
    syncAs('Shift A', { readings: [reading('Shift A'), reading('Shift A')] });
    expect(pull(0).recent.readings).toHaveLength(2);
  });

  it('does not leak another shift’s records', () => {
    syncAs('Shift A', { readings: [reading('Shift A')] });
    syncAs('Shift B', { readings: [reading('Shift B'), reading('Shift B')] });

    const mine = pull(0).recent.readings;
    expect(mine).toHaveLength(1);
    expect(mine.every((r) => r.shiftGroup === 'Shift A')).toBe(true);
  });

  it('excludes records older than seven days', () => {
    syncAs('Shift A', { readings: [reading('Shift A')] });
    // received_at is server-set; age it directly to simulate an old record.
    db.prepare("UPDATE tank_readings SET received_at = datetime('now', '-8 days')").run();

    expect(pull(0).recent.readings).toHaveLength(0);
  });

  it('keeps a record just inside the window', () => {
    syncAs('Shift A', { readings: [reading('Shift A')] });
    db.prepare("UPDATE tank_readings SET received_at = datetime('now', '-6 days')").run();

    expect(pull(0).recent.readings).toHaveLength(1);
  });

  it('carries clientId so the phone can match its own queued records', () => {
    const record = reading('Shift A');
    syncAs('Shift A', { readings: [record] });
    expect(pull(0).recent.readings[0].clientId).toBe(record.clientId);
  });

  it('includes photo paths for display when online', () => {
    const photo = `uploads/${'a'.repeat(32)}.jpg`;
    syncAs('Shift A', { readings: [reading('Shift A', { photoPath: photo })] });
    expect(pull(0).recent.readings[0].photoPath).toBe(photo);
  });

  it('emits ISO-8601 timestamps throughout', () => {
    syncAs('Shift A', { readings: [reading('Shift A')] });
    const row = pull(0).recent.readings[0];
    expect(row.readingAt).toBe('2026-09-02T01:10:00.000Z');
    expect(row.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('covers all four record types', () => {
    const taskId = seedTask(db, seedEquipment(db));
    syncAs('Shift A', {
      readings: [reading('Shift A')],
      activities: [{
        clientId: randomUUID(), type: 'OPERATOR', description: 'buka valve drain kolom A',
        activityAt: '2026-09-02T02:00:00.000Z', operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
      cleaning: [{
        clientId: randomUUID(), location: 'lantai U-93', operatorName: 'Budi',
        shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
      taskLogs: [{
        clientId: randomUUID(), taskId, newStatus: 'IN_PROGRESS', progressPct: 50,
        operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
    });

    const { recent } = pull(0);
    expect(recent.readings).toHaveLength(1);
    expect(recent.activities).toHaveLength(1);
    expect(recent.cleaning).toHaveLength(1);
    expect(recent.taskLogs).toHaveLength(1);
  });

  it('refills a shift with its own equipment status changes', () => {
    const equipmentId = seedEquipment(db, { tagNumber: 'P-9200' });
    syncAs('Shift A', {
      equipmentStatus: [{
        clientId: randomUUID(), equipmentId, newStatus: 'ON_REPAIR',
        description: 'menunggu spare part', changedAt: '2026-09-02T03:00:00.000Z',
        operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
    });

    const own = pull(0).recent.equipmentStatus;
    expect(own).toHaveLength(1);
    expect(own[0].newStatus).toBe('ON_REPAIR');
    expect(own[0].description).toBe('menunggu spare part');

    // Another shift's change is not this handset's offline window to refill;
    // the current reason reaches it on the master row instead.
    const other = seedShiftAccount(db, { code: 'SHIFT_B', displayName: 'Shift B' });
    expect(buildPull(db, { id: other, code: 'SHIFT_B', displayName: 'Shift B' }, 0)
      .recent.equipmentStatus).toEqual([]);
  });
});

/* ------------------------------------------------- equipment status on master */

describe('equipment status note (doc 02 §1.2)', () => {
  it('carries the latest reason, whoever wrote it, on the master row', () => {
    const equipmentId = seedEquipment(db, { tagNumber: 'P-9300' });

    const before = pull(0).master.equipment.find((e) => e.id === equipmentId);
    expect(before.statusNote).toBe('');

    syncAs('Shift B', {
      equipmentStatus: [{
        clientId: randomUUID(), equipmentId, newStatus: 'NEED_REPAIR',
        description: 'seal bocor', changedAt: '2026-09-02T03:00:00.000Z',
        operatorName: 'Slamet', shiftGroup: 'Shift B', shiftTime: 'sore',
      }],
    });

    const after = pull(0).master.equipment.find((e) => e.id === equipmentId);
    expect(after.status).toBe('NEED_REPAIR');
    expect(after.statusNote).toBe('seal bocor');
    expect(after.statusChangedBy).toBe('Slamet');
    expect(after.statusChangedAt).toBeTruthy();
  });

  it('lets a later admin change win over an earlier one from a handset', () => {
    // changed_at holds two formats: ISO from the phone, SQLite's space-separated
    // form from the admin route's column default. Comparing them as text put
    // every phone entry above every admin entry on the same date, whatever the
    // real time -- so an admin who corrected a status saw the phone's older
    // reason keep displaying. Ordering is by received_at, which this server
    // writes on every row in one format.
    const equipmentId = seedEquipment(db, { tagNumber: 'P-9302' });

    syncAs('Shift A', {
      equipmentStatus: [{
        clientId: randomUUID(), equipmentId, newStatus: 'NEED_REPAIR',
        description: 'dari HP', changedAt: '2026-09-04T04:38:25.223Z',
        operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
    });

    // The admin's entry lands later (higher id, later received_at) but its
    // changed_at is SQLite-format and sorts BELOW the phone's ISO on any text
    // comparison -- and deliberately at an earlier wall-clock second, so a
    // naive changed_at ordering cannot accidentally get this right.
    db.prepare(`
      INSERT INTO equipment_status_log
        (equipment_id, old_status, new_status, description, changed_by_name,
         changed_at, received_at)
      VALUES (?, 'NEED_REPAIR', 'ON_REPAIR', 'dari admin', 'admin',
              '2026-09-04 04:38:20', datetime('now'))
    `).run(equipmentId);
    db.prepare("UPDATE equipment SET status = 'ON_REPAIR' WHERE id = ?").run(equipmentId);
    stampMaster(db, 'equipment', equipmentId);

    const row = pull(0).master.equipment.find((e) => e.id === equipmentId);
    expect(row.status).toBe('ON_REPAIR');
    expect(row.statusNote).toBe('dari admin');
    expect(row.statusChangedBy).toBe('admin');
  });

  it('reaches the other handsets through the delta, not a full resync', () => {
    const equipmentId = seedEquipment(db, { tagNumber: 'P-9301' });
    stampEverything();
    const since = currentDataVersion(db);

    syncAs('Shift A', {
      equipmentStatus: [{
        clientId: randomUUID(), equipmentId, newStatus: 'STANDBY',
        description: 'dipakai bergantian dengan P-9101', changedAt: '2026-09-02T04:00:00.000Z',
        operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
    });

    const delta = pull(since);
    expect(totalMasterRows(delta)).toBe(1);
    expect(delta.master.equipment[0].statusNote).toBe('dipakai bergantian dengan P-9101');
  });
});

/* ------------------------------------------------------------------- route */

describe('GET /api/pull', () => {
  async function token() {
    const response = await login(postRequest('http://localhost/api/auth/login', {
      username: 'shift_a', password: TEST_PASSWORD, deviceName: 'HP-1', appVersion: '1.0.0',
    }));
    return (await response.json()).token;
  }

  const get = (url, headers) => new Request(url, { method: 'GET', headers });

  it('requires a device token', async () => {
    const response = await pullRoute(get('http://localhost/api/pull?since=0'));
    expect(response.status).toBe(401);
  });

  it('returns the full envelope', async () => {
    const response = await pullRoute(get('http://localhost/api/pull?since=0', withBearer(await token())));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('dataVersion');
    expect(body).toHaveProperty('master.tanks');
    expect(body).toHaveProperty('recent.readings');
    expect(body.serverTime).toMatch(/Z$/);
  });

  it('treats a missing since as a full sync', async () => {
    const response = await pullRoute(get('http://localhost/api/pull', withBearer(await token())));
    expect(response.status).toBe(200);
    expect((await response.json()).master.tanks).toHaveLength(2);
  });

  it('scopes recent to the token’s own shift', async () => {
    // Proves the isolation holds through the real auth path, not just in the
    // library call where the account is passed in by the test.
    syncAs('Shift B', { readings: [reading('Shift B')] });
    syncAs('Shift A', { readings: [reading('Shift A')] });

    const response = await pullRoute(get('http://localhost/api/pull?since=0', withBearer(await token())));
    const body = await response.json();
    expect(body.recent.readings).toHaveLength(1);
    expect(body.recent.readings[0].shiftGroup).toBe('Shift A');
  });
});
