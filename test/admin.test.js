import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as adminLogin } from '@/app/api/admin/login/route';
import { POST as adminLogout } from '@/app/api/admin/logout/route';
import { GET as listTanks, POST as createTank } from '@/app/api/admin/tanks/route';
import { DELETE as deleteTank, PUT as updateTank } from '@/app/api/admin/tanks/[id]/route';
import { GET as listEquipment, POST as createEquipment } from '@/app/api/admin/equipment/route';
import { DELETE as deleteEquipment, PUT as updateEquipment } from '@/app/api/admin/equipment/[id]/route';
import { GET as statusHistory, POST as changeStatus } from '@/app/api/admin/equipment/[id]/status/route';
import { GET as listContractors, POST as createContractor } from '@/app/api/admin/contractors/route';
import { DELETE as deleteContractor, PUT as updateContractor } from '@/app/api/admin/contractors/[id]/route';
import { GET as listShifts } from '@/app/api/admin/shifts/route';
import { PUT as setShiftPassword } from '@/app/api/admin/shifts/[id]/password/route';
import { POST as addCrew } from '@/app/api/admin/shifts/[id]/crew/route';
import { DELETE as removeCrew } from '@/app/api/admin/shifts/[id]/crew/[crewId]/route';
import { POST as createTask } from '@/app/api/admin/tasks/route';
import { PUT as updateTask } from '@/app/api/admin/tasks/[id]/route';
import { GET as listDevices } from '@/app/api/admin/devices/route';
import { POST as revokeDevice } from '@/app/api/admin/devices/[id]/revoke/route';
import { GET as browseData } from '@/app/api/admin/data/route';
import { GET as exportData } from '@/app/api/admin/data/export/route';
import { GET as listActions } from '@/app/api/admin/actions/route';
import { POST as uploadApk } from '@/app/api/admin/apk/route';
import { POST as deviceLogin } from '@/app/api/auth/login/route';
import { currentDataVersion } from '@/lib/dataversion';
import { LIMITS } from '@/lib/ratelimit';
import { createSession, SESSION_COOKIE } from '@/lib/session';
import { processSync } from '@/lib/sync';
import { parse, syncSchema } from '@/lib/validation';
import {
  TEST_PASSWORD,
  cleanupTempDbs,
  postRequest,
  seedAdmin,
  seedEquipment,
  seedShiftAccount,
  seedTanks,
  seedTask,
  useTempDb,
} from './helpers/seed.js';

const BASE = 'http://localhost';

let db;
let cookie;

beforeEach(() => {
  db = useTempDb();
  process.env.SESSION_SECRET = 'a'.repeat(64);
  seedAdmin(db);
  cookie = { cookie: `${SESSION_COOKIE}=${createSession('admin')}` };
});
afterAll(cleanupTempDbs);

/* Route handlers receive params as a promise in Next 15+. */
const ctx = (params) => ({ params: Promise.resolve(params) });
const get = (url, headers = cookie) => new Request(`${BASE}${url}`, { method: 'GET', headers });
const post = (url, body, headers = cookie) => postRequest(`${BASE}${url}`, body, headers);
const put = (url, body, headers = cookie) => new Request(`${BASE}${url}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const del = (url, headers = cookie) => new Request(`${BASE}${url}`, { method: 'DELETE', headers });

const auditCount = () => db.prepare('SELECT COUNT(*) n FROM admin_actions').get().n;

/* --------------------------------------------------------------- admin auth */

describe('admin authentication', () => {
  it('issues an httpOnly session cookie on valid credentials', async () => {
    const response = await adminLogin(post('/api/admin/login', { username: 'admin', password: TEST_PASSWORD }, {}));
    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('rejects a wrong password generically', async () => {
    const response = await adminLogin(post('/api/admin/login', { username: 'admin', password: 'salah' }, {}));
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toBe('Username atau password salah');
  });

  it('gives an unknown admin an identical response', async () => {
    const wrong = await adminLogin(post('/api/admin/login', { username: 'admin', password: 'salah' }, {}));
    const unknown = await adminLogin(post('/api/admin/login', { username: 'nobody', password: 'salah' }, {}));
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('locks out after five failures — stricter than the device login', async () => {
    for (let i = 0; i < LIMITS.adminLogin.limit; i += 1) {
      await adminLogin(post('/api/admin/login', { username: 'admin', password: 'salah' }, {}));
    }
    const blocked = await adminLogin(post('/api/admin/login', { username: 'admin', password: 'salah' }, {}));
    expect(blocked.status).toBe(429);
  });

  it('clears the cookie on logout', async () => {
    const response = await adminLogout();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('refuses every admin route without a session', async () => {
    for (const call of [
      () => listTanks(get('/api/admin/tanks', {})),
      () => listEquipment(get('/api/admin/equipment', {})),
      () => listContractors(get('/api/admin/contractors', {})),
      () => listShifts(get('/api/admin/shifts', {})),
      () => listDevices(get('/api/admin/devices', {})),
      () => listActions(get('/api/admin/actions', {})),
      () => browseData(get('/api/admin/data?type=readings', {})),
      () => createTank(post('/api/admin/tanks', { code: 'X', name: 'X', heightMm: 1 }, {})),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });

  it('refuses a forged session cookie', async () => {
    const forged = { cookie: `${SESSION_COOKIE}=fake.signature` };
    expect((await listTanks(get('/api/admin/tanks', forged))).status).toBe(401);
  });
});

/* -------------------------------------------------------------------- tanks */

describe('tanks', () => {
  const valid = { code: '93T-403', name: 'Tangki Sulfur 93T-403', heightMm: 8000 };

  it('creates, lists, updates and soft-deletes', async () => {
    const created = await createTank(post('/api/admin/tanks', valid));
    expect(created.status).toBe(201);
    const { tank } = await created.json();
    expect(tank.code).toBe('93T-403');

    const listed = await (await listTanks(get('/api/admin/tanks'))).json();
    expect(listed.tanks).toHaveLength(1);

    const updated = await updateTank(
      put(`/api/admin/tanks/${tank.id}`, { ...valid, heightMm: 8100 }), ctx({ id: String(tank.id) }),
    );
    expect((await updated.json()).tank.heightMm).toBe(8100);

    const removed = await deleteTank(del(`/api/admin/tanks/${tank.id}`), ctx({ id: String(tank.id) }));
    expect(removed.status).toBe(200);

    // Soft delete: the row survives so past readings stay interpretable.
    const after = db.prepare('SELECT is_active FROM tanks WHERE id = ?').get(tank.id);
    expect(after.is_active).toBe(0);
  });

  it('rejects a duplicate code with 409', async () => {
    await createTank(post('/api/admin/tanks', valid));
    const second = await createTank(post('/api/admin/tanks', valid));
    expect(second.status).toBe(409);
  });

  it('rejects a non-positive height', async () => {
    expect((await createTank(post('/api/admin/tanks', { ...valid, heightMm: 0 }))).status).toBe(400);
    expect((await createTank(post('/api/admin/tanks', { ...valid, heightMm: -1 }))).status).toBe(400);
  });

  it('spells out a height change in the audit detail', async () => {
    // Every stored level was computed from the height, so changing it alters
    // what past readings mean — the trail should say so plainly.
    const { tank } = await (await createTank(post('/api/admin/tanks', valid))).json();
    await updateTank(put(`/api/admin/tanks/${tank.id}`, { ...valid, heightMm: 8100 }), ctx({ id: String(tank.id) }));

    const detail = db.prepare("SELECT detail FROM admin_actions WHERE action = 'UPDATE'").get().detail;
    expect(detail).toContain('8000');
    expect(detail).toContain('8100');
  });

  it('404s an unknown id', async () => {
    expect((await updateTank(put('/api/admin/tanks/999', valid), ctx({ id: '999' }))).status).toBe(404);
  });
});

/* ---------------------------------------------------------------- equipment */

describe('equipment status (doc 10 §2.5)', () => {
  let equipmentId;
  beforeEach(() => { equipmentId = seedEquipment(db); });

  it('refuses a status change with no description', async () => {
    const response = await changeStatus(
      post(`/api/admin/equipment/${equipmentId}/status`, { status: 'ON_REPAIR' }),
      ctx({ id: String(equipmentId) }),
    );
    expect(response.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM equipment_status_log').get().n).toBe(0);
  });

  it('refuses a blank description', async () => {
    const response = await changeStatus(
      post(`/api/admin/equipment/${equipmentId}/status`, { status: 'ON_REPAIR', description: '' }),
      ctx({ id: String(equipmentId) }),
    );
    expect(response.status).toBe(400);
  });

  it('records the change and its reason', async () => {
    const response = await changeStatus(
      post(`/api/admin/equipment/${equipmentId}/status`, {
        status: 'ON_REPAIR', description: 'bearing rusak, menunggu spare part',
      }),
      ctx({ id: String(equipmentId) }),
    );
    expect(response.status).toBe(200);

    const log = db.prepare('SELECT * FROM equipment_status_log').get();
    expect(log.old_status).toBe('NORMAL');
    expect(log.new_status).toBe('ON_REPAIR');
    expect(log.description).toBe('bearing rusak, menunggu spare part');

    const row = db.prepare('SELECT status, status_changed_at FROM equipment WHERE id = ?').get(equipmentId);
    expect(row.status).toBe('ON_REPAIR');
    expect(row.status_changed_at).toBeTruthy();
  });

  it('409s when the status is already what was asked for', async () => {
    const response = await changeStatus(
      post(`/api/admin/equipment/${equipmentId}/status`, { status: 'NORMAL', description: 'tidak berubah' }),
      ctx({ id: String(equipmentId) }),
    );
    expect(response.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) n FROM equipment_status_log').get().n).toBe(0);
  });

  it('rejects a status outside the vocabulary', async () => {
    const response = await changeStatus(
      post(`/api/admin/equipment/${equipmentId}/status`, { status: 'BROKEN', description: 'x' }),
      ctx({ id: String(equipmentId) }),
    );
    expect(response.status).toBe(400);
  });

  it('returns the history newest first', async () => {
    for (const [status, description] of [['ON_REPAIR', 'rusak'], ['NORMAL', 'selesai diperbaiki']]) {
      await changeStatus(
        post(`/api/admin/equipment/${equipmentId}/status`, { status, description }),
        ctx({ id: String(equipmentId) }),
      );
    }
    const { history } = await (await statusHistory(get(`/api/admin/equipment/${equipmentId}/status`), ctx({ id: String(equipmentId) }))).json();
    expect(history).toHaveLength(2);
    expect(history[0].newStatus).toBe('NORMAL');
  });

  it('does not let the general update change status silently', async () => {
    // Status has its own endpoint precisely because it demands a reason; the
    // plain update must not offer a way around equipment_status_log.
    await updateEquipment(
      put(`/api/admin/equipment/${equipmentId}`, {
        tagNumber: 'P-9101', name: 'Kompresor', status: 'ON_REPAIR',
      }),
      ctx({ id: String(equipmentId) }),
    );
    expect(db.prepare('SELECT status FROM equipment WHERE id = ?').get(equipmentId).status).toBe('NORMAL');
    expect(db.prepare('SELECT COUNT(*) n FROM equipment_status_log').get().n).toBe(0);
  });
});

/* ------------------------------------------------------------------- shifts */

describe('shifts and crew', () => {
  let shiftId;
  beforeEach(() => { shiftId = seedShiftAccount(db); });

  it('never exposes the password hash', async () => {
    const body = await (await listShifts(get('/api/admin/shifts'))).json();
    expect(JSON.stringify(body)).not.toContain('$2');
    expect(body.shifts[0]).not.toHaveProperty('passwordHash');
  });

  it('changes a password and lets the shift log in with it', async () => {
    const response = await setShiftPassword(
      put(`/api/admin/shifts/${shiftId}/password`, { password: 'passwordbaru123' }),
      ctx({ id: String(shiftId) }),
    );
    expect(response.status).toBe(200);

    const login = await deviceLogin(postRequest(`${BASE}/api/auth/login`, {
      username: 'shift_a', password: 'passwordbaru123', deviceName: 'HP-1', appVersion: '1.0.0',
    }));
    expect(login.status).toBe(200);
  });

  it('never writes the password into the audit trail', async () => {
    await setShiftPassword(
      put(`/api/admin/shifts/${shiftId}/password`, { password: 'sangatrahasia99' }),
      ctx({ id: String(shiftId) }),
    );
    const dump = JSON.stringify(db.prepare('SELECT * FROM admin_actions').all());
    expect(dump).not.toContain('sangatrahasia99');
  });

  it('rejects a short password', async () => {
    const response = await setShiftPassword(
      put(`/api/admin/shifts/${shiftId}/password`, { password: 'short' }),
      ctx({ id: String(shiftId) }),
    );
    expect(response.status).toBe(400);
  });

  it('leaves live device tokens alone when the password changes', async () => {
    // Three handsets may be mid-shift with unsynced records; silently signing
    // them out could strand that work behind a login screen.
    await deviceLogin(postRequest(`${BASE}/api/auth/login`, {
      username: 'shift_a', password: TEST_PASSWORD, deviceName: 'HP-1', appVersion: '1.0.0',
    }));
    await setShiftPassword(
      put(`/api/admin/shifts/${shiftId}/password`, { password: 'passwordbaru123' }),
      ctx({ id: String(shiftId) }),
    );
    expect(db.prepare('SELECT revoked_at FROM device_tokens').get().revoked_at).toBeNull();
  });

  it('adds and soft-deletes crew', async () => {
    const added = await addCrew(post(`/api/admin/shifts/${shiftId}/crew`, { name: 'Budi' }), ctx({ id: String(shiftId) }));
    expect(added.status).toBe(201);
    const { crew } = await added.json();

    const removed = await removeCrew(
      del(`/api/admin/shifts/${shiftId}/crew/${crew.id}`),
      ctx({ id: String(shiftId), crewId: String(crew.id) }),
    );
    expect(removed.status).toBe(200);
    expect(db.prepare('SELECT is_active FROM shift_crew WHERE id = ?').get(crew.id).is_active).toBe(0);
  });

  it('will not remove crew belonging to another shift', async () => {
    const other = seedShiftAccount(db, { code: 'SHIFT_B', displayName: 'Shift B' });
    const { crew } = await (await addCrew(post(`/api/admin/shifts/${other}/crew`, { name: 'Joko' }), ctx({ id: String(other) }))).json();

    const response = await removeCrew(
      del(`/api/admin/shifts/${shiftId}/crew/${crew.id}`),
      ctx({ id: String(shiftId), crewId: String(crew.id) }),
    );
    expect(response.status).toBe(404);
    expect(db.prepare('SELECT is_active FROM shift_crew WHERE id = ?').get(crew.id).is_active).toBe(1);
  });
});

/* ------------------------------------------------------------------ devices */

describe('devices', () => {
  beforeEach(() => seedShiftAccount(db));

  async function signInDevice(deviceName = 'HP-1', appVersion = '1.0.0') {
    const response = await deviceLogin(postRequest(`${BASE}/api/auth/login`, {
      username: 'shift_a', password: TEST_PASSWORD, deviceName, appVersion,
    }));
    return (await response.json()).token;
  }

  it('lists devices with their app version, and never the token hash', async () => {
    await signInDevice('HP-1', '1.2.3');
    const body = await (await listDevices(get('/api/admin/devices'))).json();

    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].appVersion).toBe('1.2.3');
    expect(body.devices[0].deviceName).toBe('HP-1');
    expect(JSON.stringify(body)).not.toContain('token');
  });

  it('revokes a device and blocks its next request', async () => {
    const token = await signInDevice();
    const id = db.prepare('SELECT id FROM device_tokens').get().id;

    expect((await revokeDevice(post(`/api/admin/devices/${id}/revoke`, {}), ctx({ id: String(id) }))).status).toBe(200);
    expect(db.prepare('SELECT revoked_at FROM device_tokens WHERE id = ?').get(id).revoked_at).toBeTruthy();

    const { GET: pull } = await import('@/app/api/pull/route');
    const after = await pull(new Request(`${BASE}/api/pull?since=0`, {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(after.status).toBe(401);
  });
});

/* --------------------------------------------------------------- field data */

describe('data browsing and export', () => {
  let tanks;

  beforeEach(() => {
    seedShiftAccount(db);
    tanks = seedTanks(db);
    // Two shifts means two syncs: shift_group now comes from the authenticated
    // account, so one batch can only ever belong to one shift.
    const asShift = (displayName, payload) => {
      const parsed = parse(syncSchema, payload);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.details));
      processSync(db, parsed.data, { displayName });
    };

    asShift('Shift A', {
      readings: [{
        clientId: '11111111-1111-4111-8111-111111111111', tankId: tanks.t401,
        dcsLevelMm: 5000, tapeLengthMm: 2901, bandulSulfurMm: 35,
        operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
        readingAt: '2026-09-02T01:10:00.000Z',
      }],
    });
    asShift('Shift B', {
      activities: [{
        clientId: '22222222-2222-4222-8222-222222222222', type: 'OPERATOR',
        description: 'buka valve drain kolom A', activityAt: '2026-09-02T02:00:00.000Z',
        operatorName: 'Budi', shiftGroup: 'Shift B', shiftTime: 'sore',
      }],
    });
  });

  it('returns readings joined to their tank code', async () => {
    const body = await (await browseData(get('/api/admin/data?type=readings'))).json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].tankCode).toBe('93T-401');
    expect(body.rows[0].levelMm).toBe(5087);
  });

  it('filters by shift group', async () => {
    const a = await (await browseData(get('/api/admin/data?type=activities&shiftGroup=Shift%20A'))).json();
    const b = await (await browseData(get('/api/admin/data?type=activities&shiftGroup=Shift%20B'))).json();
    expect(a.rows).toHaveLength(0);
    expect(b.rows).toHaveLength(1);
  });

  it('treats the "to" date as the whole day, not midnight', async () => {
    // An admin filtering 2 Sep to 2 Sep means all of the 2nd. Comparing against
    // bare midnight would silently exclude every record of that day.
    const body = await (await browseData(get('/api/admin/data?type=readings&from=2026-09-02&to=2026-09-02'))).json();
    expect(body.rows).toHaveLength(1);
  });

  it('rejects an unknown type', async () => {
    expect((await browseData(get('/api/admin/data?type=secrets'))).status).toBe(400);
  });

  it('exports CSV with headers and a BOM for Excel', async () => {
    const response = await exportData(get('/api/admin/data/export?type=readings'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename=".*\.csv"/);

    // Asserted on the raw bytes, not via .text(): the fetch spec's UTF-8 decode
    // strips a leading BOM, so reading the body as text would hide whether the
    // bytes Excel actually receives carry it.
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const text = bytes.toString('utf8');
    expect(text).toContain('Level Aktual (mm)');
    expect(text).toContain('5087');
    expect(text).toContain('\r\n');
  });

  it('neutralises formulas so a note cannot execute in Excel', async () => {
    processSync(db, parse(syncSchema, {
      activities: [{
        clientId: '33333333-3333-4333-8333-333333333333', type: 'OPERATOR',
        description: '=cmd|calc', activityAt: '2026-09-02T03:00:00.000Z',
        operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
      }],
    }).data, { displayName: 'Shift A' });

    const text = await (await exportData(get('/api/admin/data/export?type=activities'))).text();
    expect(text).toContain("'=cmd|calc");
    expect(text).not.toMatch(/(^|,)=cmd/m);
  });

  it('audits the export — it is the moment data leaves the system', async () => {
    await exportData(get('/api/admin/data/export?type=readings'));
    const action = db.prepare("SELECT * FROM admin_actions WHERE action = 'EXPORT'").get();
    expect(action).toBeTruthy();
    expect(action.admin_username).toBe('admin');
  });
});

/* -------------------------------------------------------- the audit sweep */

describe('every mutation is audited and stamped', () => {
  /**
   * The acceptance criterion for this task, checked mechanically rather than
   * by trusting each route to remember. `master` marks mutations that must also
   * move dataVersion — anything the handsets pull by delta.
   */
  function operations() {
    const equipmentId = seedEquipment(db, { tagNumber: 'P-SWEEP' });
    const shiftId = seedShiftAccount(db, { code: 'SHIFT_C', displayName: 'Shift C' });
    const taskId = seedTask(db, equipmentId);
    const tankId = seedTanks(db).t401;

    return [
      { name: 'create tank', master: true, run: () => createTank(post('/api/admin/tanks', { code: 'X-1', name: 'X', heightMm: 100 })) },
      { name: 'update tank', master: true, run: () => updateTank(put(`/api/admin/tanks/${tankId}`, { code: '93T-401', name: 'T', heightMm: 7953 }), ctx({ id: String(tankId) })) },
      { name: 'delete tank', master: true, run: () => deleteTank(del(`/api/admin/tanks/${tankId}`), ctx({ id: String(tankId) })) },
      { name: 'create equipment', master: true, run: () => createEquipment(post('/api/admin/equipment', { tagNumber: 'P-NEW', name: 'Pompa' })) },
      { name: 'update equipment', master: true, run: () => updateEquipment(put(`/api/admin/equipment/${equipmentId}`, { tagNumber: 'P-SWEEP', name: 'Kompresor B' }), ctx({ id: String(equipmentId) })) },
      { name: 'change status', master: true, run: () => changeStatus(post(`/api/admin/equipment/${equipmentId}/status`, { status: 'ON_REPAIR', description: 'rusak' }), ctx({ id: String(equipmentId) })) },
      { name: 'delete equipment', master: true, run: () => deleteEquipment(del(`/api/admin/equipment/${equipmentId}`), ctx({ id: String(equipmentId) })) },
      { name: 'create contractor', master: true, run: () => createContractor(post('/api/admin/contractors', { name: 'PT Sweep' })) },
      { name: 'update contractor', master: true, run: async () => { const { contractor } = await (await createContractor(post('/api/admin/contractors', { name: 'PT Edit' }))).json(); return updateContractor(put(`/api/admin/contractors/${contractor.id}`, { name: 'PT Edited' }), ctx({ id: String(contractor.id) })); } },
      { name: 'delete contractor', master: true, run: async () => { const { contractor } = await (await createContractor(post('/api/admin/contractors', { name: 'PT Hapus' }))).json(); return deleteContractor(del(`/api/admin/contractors/${contractor.id}`), ctx({ id: String(contractor.id) })); } },
      { name: 'shift password', master: true, run: () => setShiftPassword(put(`/api/admin/shifts/${shiftId}/password`, { password: 'passwordbaru123' }), ctx({ id: String(shiftId) })) },
      { name: 'add crew', master: true, run: () => addCrew(post(`/api/admin/shifts/${shiftId}/crew`, { name: 'Sweep' }), ctx({ id: String(shiftId) })) },
      { name: 'remove crew', master: true, run: async () => { const { crew } = await (await addCrew(post(`/api/admin/shifts/${shiftId}/crew`, { name: 'Hapus' }), ctx({ id: String(shiftId) }))).json(); return removeCrew(del(`/api/admin/shifts/${shiftId}/crew/${crew.id}`), ctx({ id: String(shiftId), crewId: String(crew.id) })); } },
      { name: 'create task', master: true, run: () => createTask(post('/api/admin/tasks', { equipmentId, title: 'Ganti seal' })) },
      { name: 'update task', master: true, run: () => updateTask(put(`/api/admin/tasks/${taskId}`, { equipmentId, title: 'Ganti bearing', status: 'IN_PROGRESS', progressPct: 40 }), ctx({ id: String(taskId) })) },
      // Not master: an APK is not pulled by delta, so it must be audited
      // without moving dataVersion. Multipart, so it builds its own request
      // rather than using the JSON helper.
      { name: 'upload apk', master: false, run: () => { const form = new FormData(); form.set('version', '9.9.9'); const zip = Buffer.alloc(64); Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(zip); form.set('file', new Blob([zip]), 'build.apk'); return uploadApk(new Request(`${BASE}/api/admin/apk`, { method: 'POST', headers: cookie, body: form })); } },
    ];
  }

  it('writes an admin_actions row for each one', async () => {
    for (const operation of operations()) {
      const before = auditCount();
      const response = await operation.run();
      expect(response.status, `${operation.name} should succeed`).toBeLessThan(300);
      expect(auditCount(), `${operation.name} must be audited`).toBeGreaterThan(before);
    }
  });

  it('bumps dataVersion for each master mutation', async () => {
    for (const operation of operations().filter((o) => o.master)) {
      const before = currentDataVersion(db);
      await operation.run();
      expect(currentDataVersion(db), `${operation.name} must bump dataVersion`).toBeGreaterThan(before);
    }
  });

  it('records the acting admin on every entry', async () => {
    await createTank(post('/api/admin/tanks', { code: 'Z-9', name: 'Z', heightMm: 10 }));
    const rows = db.prepare('SELECT DISTINCT admin_username FROM admin_actions').all();
    expect(rows).toEqual([{ admin_username: 'admin' }]);
  });

  it('leaves no audit row behind when a mutation is rejected', async () => {
    seedEquipment(db, { tagNumber: 'P-REJECT' });
    const before = auditCount();
    await createTank(post('/api/admin/tanks', { code: '', name: '', heightMm: -1 }));
    expect(auditCount()).toBe(before);
  });
});

/* ------------------------------------------------------------------ actions */

describe('GET /api/admin/actions', () => {
  it('returns the trail newest first', async () => {
    await createTank(post('/api/admin/tanks', { code: 'A-1', name: 'A', heightMm: 100 }));
    await createTank(post('/api/admin/tanks', { code: 'A-2', name: 'A', heightMm: 100 }));

    const { actions } = await (await listActions(get('/api/admin/actions'))).json();
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions[0].detail).toContain('A-2');
    expect(actions[0].at).toMatch(/Z$/);
  });
});
