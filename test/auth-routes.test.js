import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as revoke } from '@/app/api/auth/revoke/route';
import { hashToken } from '@/lib/auth';
import { LOGIN_FAILURE_LIMIT } from '@/lib/ratelimit';
import {
  TEST_PASSWORD,
  cleanupTempDbs,
  postRequest,
  seedContractor,
  seedCrew,
  seedEquipment,
  seedReading,
  seedShiftAccount,
  seedTanks,
  seedTask,
  useTempDb,
  withBearer,
} from './helpers/seed.js';

const URL = 'http://localhost/api/auth/login';
const REVOKE_URL = 'http://localhost/api/auth/revoke';

let db;
beforeEach(() => { db = useTempDb(); });
afterAll(cleanupTempDbs);

function credentials(overrides = {}) {
  return { username: 'shift_a', password: TEST_PASSWORD, deviceName: 'HP-1', appVersion: '1.0.0', ...overrides };
}

async function loginOk(overrides) {
  const response = await login(postRequest(URL, credentials(overrides)));
  expect(response.status).toBe(200);
  return response.json();
}

describe('POST /api/auth/login — success', () => {
  beforeEach(() => { seedShiftAccount(db); });

  it('returns a token and marks the device as seen', async () => {
    const body = await loginOk();
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);

    const row = db.prepare('SELECT * FROM device_tokens').get();
    expect(row.device_name).toBe('HP-1');
    expect(row.app_version).toBe('1.0.0');
    expect(row.revoked_at).toBeNull();
    expect(row.last_seen_at).toBeTruthy();
  });

  it('stores the token hashed, never in the clear', async () => {
    const { token } = await loginOk();
    const row = db.prepare('SELECT * FROM device_tokens').get();
    expect(row.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('revokes the previous token for the same device — one live session per phone', async () => {
    const first = await loginOk();
    const second = await loginOk();
    expect(second.token).not.toBe(first.token);

    const rows = db.prepare('SELECT token_hash, revoked_at FROM device_tokens ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_at, 'old token revoked').toBeTruthy();
    expect(rows[1].revoked_at, 'new token live').toBeNull();
  });

  it('leaves a different device signed in', async () => {
    // Three phones share one shift account (doc 02 §1.3); signing in on HP-2
    // must not sign HP-1 out in the middle of a shift.
    await loginOk({ deviceName: 'HP-1' });
    await loginOk({ deviceName: 'HP-2' });

    const live = db.prepare('SELECT device_name FROM device_tokens WHERE revoked_at IS NULL ORDER BY device_name').all();
    expect(live.map((r) => r.device_name)).toEqual(['HP-1', 'HP-2']);
  });
});

describe('POST /api/auth/login — bootstrap bundle', () => {
  let accountId;
  let tanks;

  beforeEach(() => {
    accountId = seedShiftAccount(db);
    seedCrew(db, accountId, ['Budi', 'Slamet']);
    tanks = seedTanks(db);
    const equipmentId = seedEquipment(db);
    seedContractor(db);
    seedTask(db, equipmentId);
  });

  it('carries everything the phone needs for an offline shift', async () => {
    const body = await loginOk();

    expect(body.shiftGroup).toEqual({ code: 'SHIFT_A', displayName: 'Shift A' });
    expect(body.crew).toEqual(['Budi', 'Slamet']);
    expect(body.tanks).toHaveLength(2);
    expect(body.equipment[0].tagNumber).toBe('P-9101');
    expect(body.contractors[0].name).toBe('PT Tejo Lomanis');
    expect(body.tasks).toHaveLength(1);
    expect(body.dataVersion).toBe(0);
  });

  it('never abbreviates tank codes', async () => {
    // Doc 02 §1.1 calls this absolute — an operator reading "T-401" can measure
    // the wrong tank.
    const { tanks: payload } = await loginOk();
    expect(payload.map((t) => t.code).sort()).toEqual(['93T-401', '93T-402']);
    expect(payload.find((t) => t.code === '93T-401').heightMm).toBe(7953);
    expect(payload.find((t) => t.code === '93T-402').heightMm).toBe(7974);
  });

  it('returns the last five readings per tank, newest first', async () => {
    for (let i = 1; i <= 7; i += 1) {
      seedReading(db, tanks.t401, {
        clientId: `c${i}`,
        levelMm: 5000 + i,
        dcsLevelMm: 5000,
        readingAt: `2026-09-0${i} 01:00:00`,
      });
    }

    const { tankDeviation } = await loginOk();
    const series = tankDeviation[tanks.t401];
    expect(series).toHaveLength(5);
    expect(series[0].levelMm).toBe(5007); // newest
    expect(series.at(-1).levelMm).toBe(5003);
  });

  it('keeps each tank deviation series separate', async () => {
    // 93T-401 and 93T-402 drift differently; pooling them would corrupt the
    // tape suggestion for both (doc 02 §2.2).
    seedReading(db, tanks.t401, { clientId: 'a', levelMm: 5087, dcsLevelMm: 5000, readingAt: '2026-09-01 01:00:00' });
    seedReading(db, tanks.t402, { clientId: 'b', levelMm: 4900, dcsLevelMm: 5000, readingAt: '2026-09-01 02:00:00' });

    const { tankDeviation } = await loginOk();
    expect(tankDeviation[tanks.t401]).toHaveLength(1);
    expect(tankDeviation[tanks.t402]).toHaveLength(1);
    expect(tankDeviation[tanks.t401][0].levelMm).toBe(5087);
    expect(tankDeviation[tanks.t402][0].levelMm).toBe(4900);
  });

  it('omits readings with no DCS value — they carry no deviation', async () => {
    seedReading(db, tanks.t401, { clientId: 'x', levelMm: 5087, dcsLevelMm: null, readingAt: '2026-09-02 01:00:00' });
    seedReading(db, tanks.t401, { clientId: 'y', levelMm: 5050, dcsLevelMm: 5000, readingAt: '2026-09-01 01:00:00' });

    const { tankDeviation } = await loginOk();
    expect(tankDeviation[tanks.t401]).toHaveLength(1);
    expect(tankDeviation[tanks.t401][0].dcsLevelMm).toBe(5000);
  });

  it('emits ISO-8601 UTC timestamps, not raw SQLite format', async () => {
    seedReading(db, tanks.t401, { clientId: 'z', levelMm: 5087, dcsLevelMm: 5000, readingAt: '2026-09-02 01:10:00' });
    const { tankDeviation } = await loginOk();
    expect(tankDeviation[tanks.t401][0].readingAt).toBe('2026-09-02T01:10:00.000Z');
  });

  it('excludes inactive master rows', async () => {
    seedEquipment(db, { tagNumber: 'P-9999', name: 'Pompa lama', isActive: 0 });
    seedContractor(db, 'PT Sudah Habis Kontrak', 0);

    const body = await loginOk();
    expect(body.equipment.map((e) => e.tagNumber)).not.toContain('P-9999');
    expect(body.contractors.map((c) => c.name)).not.toContain('PT Sudah Habis Kontrak');
  });
});

describe('POST /api/auth/login — rejection', () => {
  it('rejects a wrong password with a generic message', async () => {
    seedShiftAccount(db);
    const response = await login(postRequest(URL, credentials({ password: 'salah' })));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Username atau password salah');
  });

  it('gives an unknown username the identical response — no user oracle', async () => {
    seedShiftAccount(db);
    const wrongPassword = await login(postRequest(URL, credentials({ password: 'salah' })));
    const unknownUser = await login(postRequest(URL, credentials({ username: 'shift_z' })));

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(await unknownUser.json()).toEqual(await wrongPassword.json());
  });

  it('treats a deactivated account as bad credentials', async () => {
    seedShiftAccount(db, { isActive: 0 });
    const response = await login(postRequest(URL, credentials()));
    expect(response.status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) n FROM device_tokens').get().n).toBe(0);
  });

  it('returns 400 with field details for a malformed body', async () => {
    const response = await login(postRequest(URL, { username: 'shift_a' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.some((d) => d.field === 'password')).toBe(true);
  });

  it('returns 400 for unparseable JSON', async () => {
    const response = await login(postRequest(URL, '{not json'));
    expect(response.status).toBe(400);
  });

  it('never echoes the submitted password back in an error', async () => {
    const response = await login(postRequest(URL, { username: 'shift_a', password: 'x'.repeat(500) }));
    expect(JSON.stringify(await response.json())).not.toContain('xxxx');
  });
});

describe('POST /api/auth/login — brute force guard', () => {
  it('answers 429 on the sixth failed attempt (doc 10 §2.6)', async () => {
    seedShiftAccount(db);

    for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
      const response = await login(postRequest(URL, credentials({ password: 'salah' })));
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }

    const blocked = await login(postRequest(URL, credentials({ password: 'salah' })));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('blocks the correct password too, once locked out', async () => {
    seedShiftAccount(db);
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      await login(postRequest(URL, credentials({ password: 'salah' })));
    }
    const response = await login(postRequest(URL, credentials()));
    expect(response.status).toBe(429);
  });

  it('resets the counter after a successful login', async () => {
    seedShiftAccount(db);
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i += 1) {
      await login(postRequest(URL, credentials({ password: 'salah' })));
    }
    expect((await login(postRequest(URL, credentials()))).status).toBe(200);

    // A fresh run of failures should again get the full allowance.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      const response = await login(postRequest(URL, credentials({ password: 'salah' })));
      expect(response.status).toBe(401);
    }
  });
});

describe('POST /api/auth/revoke', () => {
  it('invalidates the calling token', async () => {
    seedShiftAccount(db);
    const { token } = await loginOk();

    const response = await revoke(postRequest(REVOKE_URL, {}, withBearer(token)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(db.prepare('SELECT revoked_at FROM device_tokens').get().revoked_at).toBeTruthy();
  });

  it('makes the token unusable afterwards', async () => {
    seedShiftAccount(db);
    const { token } = await loginOk();
    await revoke(postRequest(REVOKE_URL, {}, withBearer(token)));

    const second = await revoke(postRequest(REVOKE_URL, {}, withBearer(token)));
    expect(second.status).toBe(401);
  });

  it('rejects a request with no token', async () => {
    const response = await revoke(postRequest(REVOKE_URL, {}));
    expect(response.status).toBe(401);
  });
});
