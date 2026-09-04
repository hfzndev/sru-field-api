import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as adminApks, POST as uploadApk } from '@/app/api/admin/apk/route';
import { GET as downloadApk, HEAD as checkApk } from '@/app/api/apk/latest/route';
import { POST as deviceLogin } from '@/app/api/auth/login/route';
import { apkDir, compareVersions, isApk, latestApk, listApks, storeApk } from '@/lib/apk';
import { SESSION_COOKIE, createSession } from '@/lib/session';
import {
  TEST_PASSWORD, cleanupTempDbs, postRequest, seedAdmin, seedShiftAccount, useTempDb,
} from './helpers/seed.js';

const BASE = 'http://localhost';

let db;
let cookie;

beforeEach(() => {
  db = useTempDb();
  process.env.SESSION_SECRET = 'a'.repeat(64);
  seedAdmin(db);
  seedShiftAccount(db);
  cookie = { cookie: `${SESSION_COOKIE}=${createSession('admin')}` };
});
afterAll(cleanupTempDbs);

/** Minimal bytes that pass the ZIP check — an APK is a ZIP archive. */
function apkBytes(size = 64) {
  const buffer = Buffer.alloc(size);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(buffer);
  return buffer;
}

function uploadRequest(version, buffer, headers = cookie) {
  const form = new FormData();
  form.set('version', version);
  form.set('file', new Blob([buffer]), 'whatever-the-workstation-called-it.apk');
  return new Request(`${BASE}/api/admin/apk`, { method: 'POST', headers, body: form });
}

async function deviceToken() {
  const response = await deviceLogin(postRequest(`${BASE}/api/auth/login`, {
    username: 'shift_a', password: TEST_PASSWORD, deviceName: 'HP-1', appVersion: '0.2.0',
  }));
  return (await response.json()).token;
}

/* ------------------------------------------------------------------ version */

describe('version ordering', () => {
  it('compares numerically, so 0.10.0 is newer than 0.9.0', () => {
    // The bug this exists to prevent: sorting filenames as text makes 0.10.0
    // look older than 0.9.0, and every handset is quietly downgraded.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
  });

  it('picks the newest build, not the most recently written file', () => {
    storeApk(apkBytes(), '0.10.0');
    storeApk(apkBytes(), '0.9.0'); // written second, older version
    expect(latestApk().version).toBe('0.10.0');
  });

  it('ignores files that do not follow the naming rule', () => {
    fs.mkdirSync(apkDir(), { recursive: true });
    fs.writeFileSync(path.join(apkDir(), 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(apkDir(), 'sru-field-vNext.apk'), apkBytes());
    storeApk(apkBytes(), '0.3.0');

    // One stray file in a mounted volume must not break the update check for
    // four handsets.
    expect(listApks().map((a) => a.version)).toEqual(['0.3.0']);
  });
});

/* ------------------------------------------------------------------- upload */

describe('POST /api/admin/apk', () => {
  it('publishes a build and lists it', async () => {
    const response = await uploadApk(uploadRequest('0.3.0', apkBytes(2048)));
    expect(response.status).toBe(201);

    const { apks } = await response.json();
    expect(apks[0]).toMatchObject({ version: '0.3.0', filename: 'sru-field-0.3.0.apk', bytes: 2048 });
  });

  it('names the file from the version field, never the uploaded filename', async () => {
    await uploadApk(uploadRequest('0.3.0', apkBytes()));
    expect(fs.readdirSync(apkDir())).toEqual(['sru-field-0.3.0.apk']);
  });

  it('refuses to overwrite a published version', async () => {
    await uploadApk(uploadRequest('0.3.0', apkBytes()));
    const second = await uploadApk(uploadRequest('0.3.0', apkBytes(4096)));

    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('VERSION_EXISTS');
    // The original bytes survive: some handsets running one 0.3.0 and some
    // another, with nothing to tell them apart, is the outcome being prevented.
    expect(fs.statSync(path.join(apkDir(), 'sru-field-0.3.0.apk')).size).toBe(64);
  });

  it('rejects a file that is not a ZIP archive', async () => {
    const response = await uploadApk(uploadRequest('0.3.0', Buffer.from('<html>gotcha</html>')));
    expect(response.status).toBe(415);
    expect(fs.existsSync(apkDir()) && fs.readdirSync(apkDir())).toBeFalsy();
  });

  it('rejects a malformed version', async () => {
    for (const version of ['', 'v1', '1.2', '1.2.3.4', '../../etc']) {
      const response = await uploadApk(uploadRequest(version, apkBytes()));
      expect(response.status).toBe(400);
    }
  });

  it('records the upload in the audit trail', async () => {
    await uploadApk(uploadRequest('0.3.0', apkBytes()));
    const action = db.prepare("SELECT * FROM admin_actions WHERE entity = 'apk'").get();
    expect(action.action).toBe('UPLOAD');
    expect(action.admin_username).toBe('admin');
  });

  it('needs an admin session', async () => {
    const response = await uploadApk(uploadRequest('0.3.0', apkBytes(), {}));
    expect(response.status).toBe(401);
  });

  it('lists nothing before anything is published', async () => {
    const response = await adminApks(new Request(`${BASE}/api/admin/apk`, { headers: cookie }));
    expect((await response.json()).apks).toEqual([]);
  });
});

/* ----------------------------------------------------------------- download */

describe('GET /api/apk/latest', () => {
  async function get(headers) {
    return downloadApk(new Request(`${BASE}/api/apk/latest`, { headers }));
  }

  it('streams the newest build with its version in a header', async () => {
    storeApk(apkBytes(), '0.2.0');
    storeApk(apkBytes(1024), '0.3.0');

    const response = await get({ authorization: `Bearer ${await deviceToken()}` });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-App-Version')).toBe('0.3.0');
    expect(response.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });

  it('answers HEAD with the version and no body, for a check over 2G', async () => {
    storeApk(apkBytes(5000), '0.3.0');

    const response = await checkApk(new Request(`${BASE}/api/apk/latest`, {
      method: 'HEAD', headers: { authorization: `Bearer ${await deviceToken()}` },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-App-Version')).toBe('0.3.0');
    expect(response.headers.get('Content-Length')).toBe('5000');
    expect(await response.text()).toBe('');
  });

  it('404s on a server with no build yet, rather than erroring', async () => {
    // A freshly deployed server has an empty volume, and the phone's update
    // check must read that as "nothing new".
    const response = await get({ authorization: `Bearer ${await deviceToken()}` });
    expect(response.status).toBe(404);
  });

  it('needs a device token', async () => {
    storeApk(apkBytes(), '0.3.0');
    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: 'Bearer nope' })).status).toBe(401);
    // An admin cookie is not a device credential here.
    expect((await get(cookie)).status).toBe(401);
  });
});

/* -------------------------------------------------------------------- bytes */

describe('isApk', () => {
  it('accepts a ZIP header and rejects everything else', () => {
    expect(isApk(apkBytes())).toBe(true);
    expect(isApk(Buffer.from('PK'))).toBe(false);
    expect(isApk(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false); // a JPEG
    expect(isApk(Buffer.alloc(0))).toBe(false);
  });
});
