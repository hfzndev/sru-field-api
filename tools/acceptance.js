#!/usr/bin/env node
/**
 * Phase 1 acceptance gate — doc 10 §4, plus the security checklist in doc 08 §10.
 *
 * Black-box: drives the running server over HTTP and inspects field.db to
 * confirm what actually landed. Repeatable on purpose — a gate you can only run
 * by hand once is a gate nobody runs again.
 *
 *   1. rm -rf data && SHIFT_PASSWORD=rahasia123 npm run seed:initial
 *      ADMIN_PASSWORD=admin12345 npm run seed:admin
 *   2. npm run dev
 *   3. node tools/acceptance.js
 *
 * Expects a freshly seeded database; it writes test records and will report
 * misleading counts against a database that already holds data.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

const BASE = process.env.SRU_BASE_URL || 'http://127.0.0.1:3000';
const DB_PATH = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'field.db');
const SHIFT_PASSWORD = process.env.SHIFT_PASSWORD || 'rahasia123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const results = [];
let db;

async function check(ref, name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, ref, name, detail });
    console.log(`  ${g('PASS')} ${dim(ref.padEnd(14))} ${name}${detail ? dim(`  — ${detail}`) : ''}`);
  } catch (err) {
    results.push({ ok: false, ref, name, detail: err.message });
    console.log(`  ${r('FAIL')} ${dim(ref.padEnd(14))} ${name}`);
    console.log(`         ${r(err.message)}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const uuid = () => crypto.randomUUID();

async function http(method, endpoint, { body, token, cookie, form, headers = {} } = {}) {
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: form || (body ? JSON.stringify(body) : undefined),
    redirect: 'manual',
  });
  // Read the body exactly once and hand back both views. Calling .json() here
  // and .text() at the call site throws "Body has already been read".
  const type = response.headers.get('content-type') || '';
  const text = await response.text().catch(() => '');
  let payload = null;
  if (type.includes('json') && text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  return { status: response.status, payload, text, response };
}

function reading(tankId, overrides = {}) {
  return {
    clientId: uuid(), tankId, dcsLevelMm: 5000, tapeLengthMm: 2901, bandulSulfurMm: 35,
    attempts: 2, operatorName: 'Budi', shiftGroup: 'Shift A', shiftTime: 'pagi',
    readingAt: new Date().toISOString(), ...overrides,
  };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

async function main() {
  console.log(`\n${bold('  Phase 1 acceptance')}  ${dim(BASE)}\n`);

  db = new Database(DB_PATH, { readonly: false });

  /* ---------------------------------------------- doc 10 §4: build & health */

  console.log(bold('\n  Build and health\n'));

  await check('10 §4', 'GET /api/health returns 200', async () => {
    const { status, payload } = await http('GET', '/api/health');
    expect(status === 200, `got ${status}`);
    expect(payload.database === 'connected', 'database not connected');
    return payload.status;
  });

  await check('10 §4', 'GET /api/version returns a real version', async () => {
    const { status, payload } = await http('GET', '/api/version');
    expect(status === 200, `got ${status}`);
    expect(payload.version, 'version.json is empty');
    expect(payload.commit && payload.commit !== 'nogit', 'no git metadata — check fetch-depth / .dockerignore');
    return `${payload.version} (${payload.commit})`;
  });

  /* ------------------------------------------------ doc 10 §4: sync round trip */

  console.log(bold('\n  Device sync\n'));

  let token;
  await check('10 §2.6', 'shift login returns a token and bootstrap', async () => {
    const { status, payload } = await http('POST', '/api/auth/login', {
      body: { username: 'shift_a', password: SHIFT_PASSWORD, deviceName: 'ACCEPT-1', appVersion: 'acc-1.0.0' },
    });
    expect(status === 200, `got ${status}`);
    expect(/^[0-9a-f]{64}$/.test(payload.token), 'token is not 32 random bytes');
    expect(payload.tanks.length >= 2, 'bootstrap is missing tanks');
    token = payload.token;
    return `${payload.shiftGroup.displayName}, ${payload.tanks.length} tanks`;
  });

  await check('08 §2', 'raw token is never stored', async () => {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const rows = db.prepare('SELECT * FROM device_tokens WHERE token_hash = ?').all(hash);
    expect(rows.length === 1, 'token hash not found');
    expect(!JSON.stringify(rows).includes(token), 'RAW TOKEN FOUND IN DATABASE');
    return 'only sha256 present';
  });

  const tankId = db.prepare("SELECT id FROM tanks WHERE code = '93T-401'").get().id;
  const sample = reading(tankId);

  await check('10 §4', 'sync recomputes the level server-side', async () => {
    const { status, payload } = await http('POST', '/api/sync', { token, body: { readings: [sample] } });
    expect(status === 200, `got ${status}`);
    expect(payload.acked.length === 1, 'not acked');
    expect(payload.acked[0].levelMm === 5087, `level ${payload.acked[0].levelMm}, expected 5087`);
    expect(payload.acked[0].deviationMm === 87, `deviation ${payload.acked[0].deviationMm}, expected 87`);

    const row = db.prepare('SELECT level_mm, deviation_mm FROM tank_readings WHERE client_id = ?').get(sample.clientId);
    expect(row.level_mm === 5087, `stored level ${row.level_mm}`);
    return '7953 − 2901 + 35 = 5087, dev +87';
  });

  await check('10 §2.2', 'replaying the batch does not duplicate', async () => {
    const { payload } = await http('POST', '/api/sync', { token, body: { readings: [sample] } });
    expect(payload.acked.length === 0, 'acked a duplicate');
    expect(payload.duplicates.length === 1, 'not reported as duplicate');

    const { n } = db.prepare('SELECT COUNT(*) n FROM tank_readings WHERE client_id = ?').get(sample.clientId);
    expect(n === 1, `${n} rows for one client_id`);
    return 'one row, reported as duplicate';
  });

  await check('10 §2.3', 'one bad record does not fail the batch', async () => {
    const { status, payload } = await http('POST', '/api/sync', {
      token,
      body: { readings: [reading(tankId), reading(tankId, { bandulSulfurMm: 100 })] },
    });
    expect(status === 200, `batch returned ${status}`);
    expect(payload.acked.length === 1, `acked ${payload.acked.length}, expected 1`);
    expect(payload.errors.length === 1, 'bad record not rejected');
    expect(payload.errors[0].error.code === 'BANDUL_OUT_OF_RANGE', payload.errors[0].error.code);
    return '1 acked, 1 rejected, HTTP 200';
  });

  await check('10 §2.2', 'a non-UUID clientId fails the request', async () => {
    const { status } = await http('POST', '/api/sync', {
      token, body: { readings: [reading(tankId, { clientId: 'not-a-uuid' })] },
    });
    expect(status === 400, `got ${status}`);
    return '400';
  });

  /* --------------------------------------------------- doc 10 §2.11: cleaning */

  const cleaningId = uuid();
  await check('10 §2.11', 'cleaning syncs as IN_PROGRESS then completes in place', async () => {
    const base = {
      clientId: cleaningId, location: 'lantai area U-93', operatorName: 'Budi',
      shiftGroup: 'Shift A', shiftTime: 'pagi',
    };
    await http('POST', '/api/sync', { token, body: { cleaning: [base] } });

    let row = db.prepare('SELECT status FROM cleaning_sessions WHERE client_id = ?').get(cleaningId);
    expect(row.status === 'IN_PROGRESS', `first sync gave ${row.status}`);

    const done = { ...base, afterPhoto: `uploads/${'a'.repeat(32)}.jpg`, afterPhotoAt: new Date().toISOString() };
    const { payload } = await http('POST', '/api/sync', { token, body: { cleaning: [done] } });
    expect(payload.acked[0]?.updated === true, 'not acked as an update');

    const { n } = db.prepare('SELECT COUNT(*) n FROM cleaning_sessions WHERE client_id = ?').get(cleaningId);
    expect(n === 1, `${n} rows — should be one`);

    row = db.prepare('SELECT status FROM cleaning_sessions WHERE client_id = ?').get(cleaningId);
    expect(row.status === 'DONE', `status ${row.status}`);

    const replay = await http('POST', '/api/sync', { token, body: { cleaning: [done] } });
    expect(replay.payload.duplicates.length === 1, 'replay was not idempotent');
    return 'one row, IN_PROGRESS → DONE, replay safe';
  });

  /* ----------------------------------------------------- doc 10 §2.10: pull */

  console.log(bold('\n  Delta pull\n'));

  let adminCookie;
  await check('10 §4', 'admin login sets an httpOnly session', async () => {
    const { status, response } = await http('POST', '/api/admin/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(status === 200, `got ${status}`);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie?.includes('HttpOnly'), 'cookie is not httpOnly');
    adminCookie = setCookie.split(';')[0];
    return 'HttpOnly, SameSite=Lax';
  });

  await check('10 §2.10', 'one master change yields exactly one delta row', async () => {
    const before = (await http('GET', '/api/pull?since=0', { token })).payload.dataVersion;
    await http('POST', '/api/admin/contractors', { cookie: adminCookie, body: { name: `PT Acc ${Date.now()}` } });

    const { payload } = await http('GET', `/api/pull?since=${before}`, { token });
    const rows = Object.values(payload.master).reduce((n, list) => n + list.length, 0);
    expect(rows === 1, `${rows} rows returned — delta filter is wrong (see doc 05 §2)`);
    return 'exactly 1 row, not the full master';
  });

  await check('10 §2.10', 'since=0 returns all active master rows', async () => {
    const { payload } = await http('GET', '/api/pull?since=0', { token });
    expect(payload.master.tanks.length >= 2, 'tanks missing from initial pull');
    return `${payload.master.tanks.length} tanks, ${payload.master.contractors.length} contractors`;
  });

  await check('10 §2.8', 'pull does not leak another shift’s records', async () => {
    const other = (await http('POST', '/api/auth/login', {
      body: { username: 'shift_b', password: SHIFT_PASSWORD, deviceName: 'ACCEPT-B', appVersion: 'acc' },
    })).payload.token;
    const { payload } = await http('GET', '/api/pull?since=0', { token: other });
    const leaked = payload.recent.readings.filter((row) => row.shiftGroup !== 'Shift B');
    expect(leaked.length === 0, `${leaked.length} records from another shift`);
    return 'Shift B sees only its own';
  });

  /* ------------------------------------------------------- doc 10 §2.5: admin */

  console.log(bold('\n  Admin\n'));

  let equipmentId;
  await check('10 §4', 'admin CRUD works across the master tables', async () => {
    const tag = `P-ACC-${Date.now() % 100000}`;
    const created = await http('POST', '/api/admin/equipment', { cookie: adminCookie, body: { tagNumber: tag, name: 'Alat uji' } });
    expect(created.status === 201, `equipment create ${created.status}`);
    equipmentId = created.payload.equipment.id;

    const task = await http('POST', '/api/admin/tasks', { cookie: adminCookie, body: { equipmentId, title: 'Task uji' } });
    expect(task.status === 201, `task create ${task.status}`);

    const shiftId = db.prepare("SELECT id FROM shift_accounts WHERE code = 'SHIFT_A'").get().id;
    const crew = await http('POST', `/api/admin/shifts/${shiftId}/crew`, { cookie: adminCookie, body: { name: 'Uji Crew' } });
    expect(crew.status === 201, `crew create ${crew.status}`);

    const tank = await http('POST', '/api/admin/tanks', { cookie: adminCookie, body: { code: `X-${Date.now() % 10000}`, name: 'Uji', heightMm: 1000 } });
    expect(tank.status === 201, `tank create ${tank.status}`);
    return 'equipment, task, crew, tank';
  });

  await check('10 §2.5', 'status change without a reason is refused', async () => {
    const { status } = await http('POST', `/api/admin/equipment/${equipmentId}/status`, {
      cookie: adminCookie, body: { status: 'ON_REPAIR' },
    });
    expect(status === 400, `got ${status}`);
    return '400';
  });

  await check('10 §2.5', 'status change with a reason is logged', async () => {
    const { status } = await http('POST', `/api/admin/equipment/${equipmentId}/status`, {
      cookie: adminCookie, body: { status: 'ON_REPAIR', description: 'bearing rusak' },
    });
    expect(status === 200, `got ${status}`);
    const log = db.prepare('SELECT * FROM equipment_status_log WHERE equipment_id = ?').get(equipmentId);
    expect(log?.description === 'bearing rusak', 'reason not written to the log');
    return 'NORMAL → ON_REPAIR with reason';
  });

  await check('10 §2.5', 'setting the same status again is a 409', async () => {
    const { status } = await http('POST', `/api/admin/equipment/${equipmentId}/status`, {
      cookie: adminCookie, body: { status: 'ON_REPAIR', description: 'lagi' },
    });
    expect(status === 409, `got ${status}`);
    return '409';
  });

  await check('08 §9', 'every admin mutation is audited', async () => {
    const { n } = db.prepare('SELECT COUNT(*) n FROM admin_actions').get();
    expect(n > 0, 'audit trail is empty');
    const anon = db.prepare("SELECT COUNT(*) n FROM admin_actions WHERE admin_username = ''").get().n;
    expect(anon === 0, `${anon} audit rows with no admin name`);
    return `${n} entries, all attributed`;
  });

  await check('10 §4', 'CSV export returns data with a BOM', async () => {
    const response = await fetch(`${BASE}/api/admin/data/export?type=readings`, { headers: { Cookie: adminCookie } });
    expect(response.status === 200, `got ${response.status}`);
    expect(/attachment/.test(response.headers.get('content-disposition') || ''), 'not an attachment');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, 'missing UTF-8 BOM — Excel will mangle it');
    expect(bytes.toString('utf8').includes('5087'), 'export has no reading data');
    return `${bytes.length} bytes`;
  });

  await check('10 §4', 'Devices lists the app version and hides the token hash', async () => {
    const { status, payload } = await http('GET', '/api/admin/devices', { cookie: adminCookie });
    expect(status === 200, `got ${status}`);
    const device = payload.devices.find((d) => d.deviceName === 'ACCEPT-1');
    expect(device, 'test device not listed');
    expect(device.appVersion === 'acc-1.0.0', `version ${device.appVersion}`);
    expect(!JSON.stringify(payload).includes('token_hash'), 'token hash exposed');
    return `${payload.devices.length} devices`;
  });

  /* ------------------------------------------------ doc 08 §10: security gate */

  console.log(bold('\n  Security checklist (doc 08 §10)\n'));

  await check('08 §10', 'upload rejects HTML disguised as a photo', async () => {
    const form = new FormData();
    form.append('file', new Blob([HTML]), 'photo.jpg');
    const { status } = await http('POST', '/api/upload', { token, form });
    expect(status === 415, `got ${status}`);
    return '415';
  });

  await check('08 §10', 'upload rejects a file over 5MB', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024 + 1)])]), 'big.jpg');
    const { status } = await http('POST', '/api/upload', { token, form });
    expect(status === 413, `got ${status}`);
    return '413';
  });

  await check('08 §10', 'a valid photo is stored under a UUID name', async () => {
    const form = new FormData();
    form.append('file', new Blob([JPEG]), '../../evil name.jpg');
    const { status, payload } = await http('POST', '/api/upload', { token, form });
    expect(status === 200, `got ${status}`);
    expect(/^uploads\/[0-9a-f-]{36}\.jpg$/.test(payload.path), `path ${payload.path}`);
    return payload.path;
  });

  await check('08 §10', 'photo endpoint refuses path traversal', async () => {
    for (const attempt of [
      'uploads/../../etc/passwd', '../../etc/passwd', '/etc/passwd',
      'uploads/field.db', 'uploads/.env', 'C:\\Windows\\win.ini',
    ]) {
      const { status, text } = await http('GET', `/api/photo?path=${encodeURIComponent(attempt)}`, { token });
      expect(status === 404, `${attempt} returned ${status}`);
      // A 404 with the file's contents in the body would still be a breach.
      expect(!/root:|SQLite format|SESSION_SECRET/.test(text), `LEAKED CONTENT for ${attempt}`);
    }
    return '6 attempts, all 404 with no content';
  });

  await check('08 §10', 'six wrong passwords trigger a 429', async () => {
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      last = (await http('POST', '/api/auth/login', {
        body: { username: 'shift_c', password: `salah-${i}` },
      })).status;
    }
    expect(last === 429, `sixth attempt returned ${last}`);
    return '429 on the sixth';
  });

  await check('08 §10', 'unknown user and wrong password are indistinguishable', async () => {
    const a = await http('POST', '/api/auth/login', { body: { username: 'shift_d', password: 'salah' } });
    const b = await http('POST', '/api/auth/login', { body: { username: 'tidak_ada', password: 'salah' } });
    expect(a.status === b.status, `${a.status} vs ${b.status}`);
    expect(JSON.stringify(a.payload) === JSON.stringify(b.payload), 'responses differ');
    return 'byte-identical 401';
  });

  await check('08 §10', 'zod strips unknown fields', async () => {
    const record = reading(tankId, { levelMm: 99999, injected: 'x' });
    const { payload } = await http('POST', '/api/sync', { token, body: { readings: [record] } });
    expect(payload.acked[0].levelMm === 5087, `client-supplied level was honoured: ${payload.acked[0].levelMm}`);
    return 'client cannot assert a level';
  });

  await check('08 §10', 'admin API refuses a request with no session', async () => {
    const { status } = await http('GET', '/api/admin/tanks');
    expect(status === 401, `got ${status}`);
    return '401';
  });

  await check('08 §10', 'admin pages redirect when signed out', async () => {
    const { status, response } = await http('GET', '/admin/tanks');
    expect(status === 307 || status === 302, `got ${status}`);
    expect((response.headers.get('location') || '').includes('/admin/login'), 'did not redirect to login');
    return `${status} → /admin/login`;
  });

  /* ----------------------------------------------------------------- report */

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${bold('  Result')}\n`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length) {
    console.log(`\n  ${r(bold('FAILED:'))}`);
    for (const f of failed) console.log(`    ${r('✗')} ${f.ref}  ${f.name}\n      ${dim(f.detail)}`);
  }

  console.log(`\n  ${y('Not covered here:')} the Docker image is built and smoke-tested in CI`);
  console.log(`  ${dim('(.github/workflows/deploy.yml), and the admin UI was verified in a browser.')}\n`);

  db.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(r(`\n  acceptance run failed: ${err.message}\n`));
  process.exit(1);
});
