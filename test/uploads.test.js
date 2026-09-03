import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as photoRoute } from '@/app/api/photo/route';
import { POST as uploadRoute } from '@/app/api/upload/route';
import { POST as login } from '@/app/api/auth/login/route';
import { LIMITS } from '@/lib/ratelimit';
import { createSession, SESSION_COOKIE } from '@/lib/session';
import { MAX_UPLOAD_BYTES, contentTypeFor, detectImageType, resolveStoredPhoto, uploadsDir } from '@/lib/uploads';
import { PHOTO_PATH } from '@/lib/validation';
import {
  TEST_PASSWORD,
  cleanupTempDbs,
  postRequest,
  seedShiftAccount,
  useTempDb,
  withBearer,
} from './helpers/seed.js';

const UPLOAD_URL = 'http://localhost/api/upload';
const PHOTO_URL = 'http://localhost/api/photo';

let db;
let token;

beforeEach(async () => {
  db = useTempDb();
  seedShiftAccount(db);
  process.env.SESSION_SECRET = 'a'.repeat(64);
  const response = await login(postRequest('http://localhost/api/auth/login', {
    username: 'shift_a', password: TEST_PASSWORD, deviceName: 'HP-1', appVersion: '1.0.0',
  }));
  token = (await response.json()).token;
});
afterAll(cleanupTempDbs);

/* Only the leading bytes are inspected, so these need not decode as images. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([0x40, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'), Buffer.alloc(64, 1),
]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
const PHP = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');

function upload(buffer, { filename = 'photo.jpg', type = 'image/jpeg', headers } = {}) {
  const form = new FormData();
  form.append('file', new File([buffer], filename, { type }));
  return uploadRoute(new Request(UPLOAD_URL, {
    method: 'POST',
    body: form,
    headers: headers ?? withBearer(token),
  }));
}

const getPhoto = (query, headers) => photoRoute(new Request(`${PHOTO_URL}?${query}`, { method: 'GET', headers }));

/* ------------------------------------------------------------ magic bytes */

describe('detectImageType', () => {
  it('recognises the three accepted formats', () => {
    expect(detectImageType(JPEG).ext).toBe('jpg');
    expect(detectImageType(PNG).ext).toBe('png');
    expect(detectImageType(WEBP).ext).toBe('webp');
  });

  it('rejects anything else, regardless of what it is called', () => {
    expect(detectImageType(HTML)).toBeNull();
    expect(detectImageType(PHP)).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated JPEG
  });

  it('does not mistake a bare RIFF container for WebP', () => {
    const riffWave = Buffer.concat([
      Buffer.from('RIFF', 'ascii'), Buffer.from([0x40, 0, 0, 0]),
      Buffer.from('WAVE', 'ascii'), Buffer.alloc(16, 0),
    ]);
    expect(detectImageType(riffWave)).toBeNull();
  });
});

/* ---------------------------------------------------------------- upload */

describe('POST /api/upload', () => {
  it('stores a JPEG and returns its path', async () => {
    const response = await upload(JPEG);
    expect(response.status).toBe(200);

    const { path: stored } = await response.json();
    expect(stored).toMatch(/^uploads\/[0-9a-f-]{36}\.jpg$/);
    expect(fs.existsSync(path.join(uploadsDir(), path.basename(stored)))).toBe(true);
  });

  it('returns a path the sync schema will accept', async () => {
    // The two patterns must agree, or a photo could be uploaded and then
    // rejected when its record is synced.
    const { path: stored } = await (await upload(PNG)).json();
    expect(PHOTO_PATH.test(stored)).toBe(true);
  });

  it('names files by detected type, not by the extension sent', async () => {
    const { path: stored } = await (await upload(PNG, { filename: 'photo.jpg', type: 'image/jpeg' })).json();
    expect(stored.endsWith('.png')).toBe(true);
  });

  it('discards the client filename entirely', async () => {
    const { path: stored } = await (await upload(JPEG, { filename: '../../evil shell.jpg' })).json();
    expect(stored).toMatch(/^uploads\/[0-9a-f-]{36}\.jpg$/);
    expect(stored).not.toContain('evil');
    expect(stored).not.toContain('..');
  });

  it('gives every upload a distinct name', async () => {
    const first = await (await upload(JPEG)).json();
    const second = await (await upload(JPEG)).json();
    expect(first.path).not.toBe(second.path);
  });

  it('rejects HTML disguised as a photo with 415 (doc 10 §2.9)', async () => {
    const response = await upload(HTML, { filename: 'photo.jpg', type: 'image/jpeg' });
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects PHP disguised as a photo with 415', async () => {
    expect((await upload(PHP, { filename: 'shell.php.jpg' })).status).toBe(415);
  });

  it('writes nothing to disk when the type is rejected', async () => {
    await upload(HTML);
    const dir = uploadsDir();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toHaveLength(0);
  });

  it('rejects a file over 5MB with 413', async () => {
    const oversized = Buffer.concat([JPEG, Buffer.alloc(MAX_UPLOAD_BYTES + 1)]);
    expect((await upload(oversized)).status).toBe(413);
  });

  it('rejects an oversized body before parsing it, on content-length alone', async () => {
    const form = new FormData();
    form.append('file', new File([JPEG], 'photo.jpg', { type: 'image/jpeg' }));
    const response = await uploadRoute(new Request(UPLOAD_URL, {
      method: 'POST',
      body: form,
      headers: { ...withBearer(token), 'content-length': String(MAX_UPLOAD_BYTES * 10) },
    }));
    expect(response.status).toBe(413);
  });

  it('requires the file field', async () => {
    const form = new FormData();
    form.append('notfile', 'x');
    const response = await uploadRoute(new Request(UPLOAD_URL, {
      method: 'POST', body: form, headers: withBearer(token),
    }));
    expect(response.status).toBe(400);
  });

  it('requires a device token', async () => {
    expect((await upload(JPEG, { headers: {} })).status).toBe(401);
  });

  it('throttles at 20 uploads per hour per device (doc 08 §6)', async () => {
    for (let i = 0; i < LIMITS.upload.limit; i += 1) {
      expect((await upload(JPEG)).status, `upload ${i + 1}`).toBe(200);
    }
    expect((await upload(JPEG)).status).toBe(429);
  });
});

/* ----------------------------------------------------------------- photo */

describe('GET /api/photo', () => {
  async function storedJpeg() {
    return (await (await upload(JPEG)).json()).path;
  }

  it('serves a stored photo to a device token', async () => {
    const stored = await storedJpeg();
    const response = await getPhoto(`path=${encodeURIComponent(stored)}`, withBearer(token));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
  });

  it('sets nosniff so a browser cannot re-interpret the payload', async () => {
    const response = await getPhoto(`path=${encodeURIComponent(await storedJpeg())}`, withBearer(token));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the admin session cookie too', async () => {
    const stored = await storedJpeg();
    const response = await getPhoto(`path=${encodeURIComponent(stored)}`, {
      cookie: `${SESSION_COOKIE}=${createSession('admin')}`,
    });
    expect(response.status).toBe(200);
  });

  it('rejects an unauthenticated request', async () => {
    expect((await getPhoto(`path=${encodeURIComponent(await storedJpeg())}`, {})).status).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const stored = await storedJpeg();
    const response = await getPhoto(`path=${encodeURIComponent(stored)}`, {
      cookie: `${SESSION_COOKIE}=bogus.value`,
    });
    expect(response.status).toBe(401);
  });

  it('refuses path traversal (doc 10 §2.9)', async () => {
    for (const attempt of [
      'uploads/../../etc/passwd',
      'uploads/../../../windows/win.ini',
      '../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'uploads/..%2f..%2fetc%2fpasswd',
      'uploads/subdir/photo.jpg',
    ]) {
      const response = await getPhoto(`path=${encodeURIComponent(attempt)}`, withBearer(token));
      expect(response.status, attempt).toBe(404);
    }
  });

  it('refuses a filename outside the generated pattern, even when the file is really there', async () => {
    // These must be refused because the *name* is not one this service
    // generates — not merely because the file happens to be absent. Planting
    // real files is what makes the pattern check load-bearing: without them the
    // assertions would pass on a missing-file 404 and the check could be
    // deleted unnoticed.
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const planted = ['photo.jpg', 'shell.php', '.env', 'field.db', 'notes.txt'];
    for (const name of planted) {
      fs.writeFileSync(path.join(uploadsDir(), name), 'sensitive');
    }

    for (const name of planted) {
      const response = await getPhoto(`path=${encodeURIComponent(`uploads/${name}`)}`, withBearer(token));
      expect(response.status, name).toBe(404);
      expect(await response.text()).not.toContain('sensitive');
    }
  });

  it('will not serve a well-named file of the wrong kind', async () => {
    // A UUID-named file planted in the directory still only comes back with a
    // whitelisted Content-Type and nosniff, never as executable content.
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const planted = '00000000-0000-0000-0000-000000000000.png';
    fs.writeFileSync(path.join(uploadsDir(), planted), HTML);

    const response = await getPhoto(`path=uploads/${planted}`, withBearer(token));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns 404 for a well-formed path that does not exist', async () => {
    const response = await getPhoto('path=uploads/11111111-1111-1111-1111-111111111111.jpg', withBearer(token));
    expect(response.status).toBe(404);
  });

  it('returns 404 for a missing path parameter', async () => {
    expect((await getPhoto('', withBearer(token))).status).toBe(404);
  });
});

/* ------------------------------------------------------------ path helpers */

describe('resolveStoredPhoto', () => {
  it('rejects non-string and empty input', () => {
    for (const value of [null, undefined, 42, {}, '']) {
      expect(resolveStoredPhoto(value)).toBeNull();
    }
  });

  it('rejects a path outside the uploads prefix', () => {
    expect(resolveStoredPhoto('data/field.db')).toBeNull();
    expect(resolveStoredPhoto('uploadsX/11111111-1111-1111-1111-111111111111.jpg')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('maps only whitelisted extensions', () => {
    expect(contentTypeFor('/x/a.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('/x/a.png')).toBe('image/png');
    expect(contentTypeFor('/x/a.webp')).toBe('image/webp');
    expect(contentTypeFor('/x/a.html')).toBe('application/octet-stream');
  });
});
