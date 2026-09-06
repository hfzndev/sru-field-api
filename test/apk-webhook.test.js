import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as webhook } from '@/app/api/webhook/apk-release/route';
import { apkDir, listApks } from '@/lib/apk';
import { LIMITS } from '@/lib/ratelimit';
import { cleanupTempDbs, useTempDb } from './helpers/seed.js';

const URL = 'http://localhost/api/webhook/apk-release';
const SECRET = 'w'.repeat(64);
const REPO = 'hfzndev/sru-field-app';
const ASSET_URL = 'https://api.github.com/repos/hfzndev/sru-field-app/releases/assets/42';

let db;

beforeEach(() => {
  db = useTempDb();
  process.env.APK_WEBHOOK_SECRET = SECRET;
  process.env.APK_RELEASE_REPO = REPO;
  process.env.GITHUB_TOKEN = 'ghp_test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APK_WEBHOOK_SECRET;
  delete process.env.APK_RELEASE_REPO;
  delete process.env.GITHUB_TOKEN;
});

afterAll(cleanupTempDbs);

/** Minimal bytes that pass the ZIP check — an APK is a ZIP archive. */
function apkBytes(size = 64) {
  const buffer = Buffer.alloc(size);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(buffer);
  return buffer;
}

function releasePayload({ version = '0.4.0', repo = REPO, assets, ...release } = {}) {
  return {
    action: 'published',
    repository: { full_name: repo },
    release: {
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: assets ?? [{
        id: 42, name: `sru-field-${version}.apk`, size: 70_000_000, url: ASSET_URL,
      }],
      ...release,
    },
  };
}

/** A delivery signed the way GitHub signs one, over these exact bytes. */
function delivery(payload, { secret = SECRET, event = 'release', signature, headers = {} } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const computed = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return new Request(URL, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'x-github-event': event,
      'x-github-delivery': 'd-1',
      'x-hub-signature-256': signature ?? computed,
      'x-forwarded-for': '140.82.115.1',
      ...headers,
    },
  });
}

/** Stubs the asset download; returns the mock so callers can assert on it. */
function stubDownload(bytes = apkBytes()) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function auditRows() {
  return db.prepare("SELECT * FROM admin_actions WHERE entity = 'apk'").all();
}

describe('POST /api/webhook/apk-release — the endpoint is refused before it does any work', () => {
  it('answers 503 when no secret is configured', async () => {
    delete process.env.APK_WEBHOOK_SECRET;
    const response = await webhook(delivery(releasePayload()));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('answers 401 for a missing signature', async () => {
    const response = await webhook(delivery(releasePayload(), { signature: '' }));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_SIGNATURE');
  });

  it('answers 401 for a signature made with the wrong secret', async () => {
    const response = await webhook(delivery(releasePayload(), { secret: 'not-the-secret' }));

    expect(response.status).toBe(401);
  });

  // The signature covers the exact bytes, so a body swapped after signing must
  // fail even though the header is a well-formed signature of *something*.
  it('answers 401 when the body no longer matches the signature', async () => {
    const good = delivery(releasePayload());
    const tampered = new Request(URL, {
      method: 'POST',
      body: JSON.stringify(releasePayload({ version: '9.9.9' })),
      headers: good.headers,
    });

    expect((await webhook(tampered)).status).toBe(401);
  });

  it('answers 413 for a body larger than a webhook payload could be', async () => {
    const response = await webhook(delivery(releasePayload(), {
      headers: { 'content-length': String(2 * 1024 * 1024) },
    }));

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 429 once one caller floods it', async () => {
    let response;
    for (let i = 0; i <= LIMITS.general.limit; i += 1) {
      response = await webhook(delivery({ zen: 'ping' }, { event: 'ping' }));
    }

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });

  it('answers 400 when the signed body is not JSON', async () => {
    const response = await webhook(delivery('not json at all'));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/webhook/apk-release — uninteresting deliveries are ignored, not failed', () => {
  // GitHub marks any non-2xx delivery as failed and retries it. A delivery we
  // simply do not care about is not a failure, so it answers 200.
  const ignored = async (payload, options) => {
    const response = await webhook(delivery(payload, options));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.ignored).toBeTruthy();
    expect(listApks()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
    return body;
  };

  it('ignores the ping GitHub sends when the webhook is created', async () => {
    const body = await ignored({ zen: 'Design for failure.', hook_id: 1 }, { event: 'ping' });
    expect(body.ignored).toBe('event');
  });

  it('ignores events other than release', async () => {
    await ignored({ ref: 'refs/heads/main' }, { event: 'push' });
  });

  it('ignores a release from another repository', async () => {
    const body = await ignored(releasePayload({ repo: 'someone-else/sru-field-app' }));
    expect(body.ignored).toBe('repository');
  });

  it('ignores actions other than published', async () => {
    await ignored({ ...releasePayload(), action: 'deleted' });
    await ignored({ ...releasePayload(), action: 'edited' });
  });

  it('ignores drafts and prereleases', async () => {
    await ignored(releasePayload({ draft: true }));
    await ignored(releasePayload({ prerelease: true }));
  });

  it('ignores a tag that is not v<x.y.z>', async () => {
    await ignored(releasePayload({ tag_name: '0.4.0' }));
  });

  it('ignores a release whose asset name disagrees with the tag', async () => {
    const body = await ignored(releasePayload({
      assets: [{ id: 1, name: 'sru-field-0.3.0.apk', size: 100, url: ASSET_URL }],
    }));
    expect(body.ignored).toBe('no_asset');
  });

  it('ignores a release with no APK asset at all', async () => {
    await ignored(releasePayload({ assets: [] }));
  });

  // A 300MB asset is a build made without the ABI flag, not a delivery problem.
  // Retrying it would never help, so it is ignored rather than failed.
  it('ignores an asset declared larger than the cap, without downloading it', async () => {
    const fetchMock = stubDownload();
    const body = await ignored(releasePayload({
      assets: [{ id: 1, name: 'sru-field-0.4.0.apk', size: 300 * 1024 * 1024, url: ASSET_URL }],
    }));

    expect(body.ignored).toBe('too_large');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhook/apk-release — publishing', () => {
  it('downloads the asset and stores it under the tag version', async () => {
    const bytes = apkBytes(2048);
    const fetchMock = stubDownload(bytes);

    const response = await webhook(delivery(releasePayload()));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, stored: 'sru-field-0.4.0.apk' });

    expect(fetchMock.mock.calls[0][0]).toBe(ASSET_URL);
    const stored = path.join(apkDir(), 'sru-field-0.4.0.apk');
    expect(fs.readFileSync(stored)).toEqual(bytes);
    expect(listApks()).toMatchObject([{ version: '0.4.0', filename: 'sru-field-0.4.0.apk' }]);
  });

  it('records who published it and from which release', async () => {
    stubDownload(apkBytes(1024 * 1024));
    await webhook(delivery(releasePayload()));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].admin_username).toBe('github-release');
    expect(rows[0].action).toBe('UPLOAD');
    expect(rows[0].detail).toContain('sru-field-0.4.0.apk');
    expect(rows[0].detail).toContain('via release v0.4.0');
  });

  // GitHub redelivers, and a redelivery is not a mistake to report. Answering
  // non-2xx would leave the delivery red in the repo settings forever.
  it('treats a redelivery of a version it already holds as success', async () => {
    stubDownload();
    expect((await webhook(delivery(releasePayload()))).status).toBe(201);

    stubDownload();
    const response = await webhook(delivery(releasePayload()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyExists: 'sru-field-0.4.0.apk' });
    expect(listApks()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it('answers 502 when the download fails, so GitHub retries it', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, headers: new Headers() }));

    const response = await webhook(delivery(releasePayload()));

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('DOWNLOAD_FAILED');
    expect(listApks()).toHaveLength(0);
  });

  it('answers 502 when the fetch itself throws', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNRESET'); });

    expect((await webhook(delivery(releasePayload()))).status).toBe(502);
  });

  // Same code the admin upload form returns for the same reason: what arrived
  // is not an APK, and no amount of retrying will change that.
  it('answers 415 when the bytes are not a ZIP archive', async () => {
    stubDownload(Buffer.from('this is a release note, not a build'));

    const response = await webhook(delivery(releasePayload()));

    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(listApks()).toHaveLength(0);
  });

  // A public repo needs no token, and sending `Bearer undefined` would fail a
  // request that would otherwise have worked.
  it('publishes without a token, omitting the Authorization header', async () => {
    delete process.env.GITHUB_TOKEN;
    const fetchMock = stubDownload();

    const response = await webhook(delivery(releasePayload()));

    expect(response.status).toBe(201);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('publishes a second, newer version alongside the first', async () => {
    stubDownload();
    await webhook(delivery(releasePayload({ version: '0.4.0' })));
    stubDownload();
    await webhook(delivery(releasePayload({ version: '0.5.0' })));

    expect(listApks().map((apk) => apk.version)).toEqual(['0.5.0', '0.4.0']);
  });
});
