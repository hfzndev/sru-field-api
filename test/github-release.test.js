import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAsset, isPublishableRelease, releaseAsset, releaseVersion, verifySignature,
} from '@/lib/github-release';

function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** A delivery GitHub would actually send for `v0.4.0` of the app repo. */
function payload(release = {}) {
  return {
    action: 'published',
    repository: { full_name: 'hfzndev/sru-field-app' },
    release: {
      tag_name: 'v0.4.0',
      draft: false,
      prerelease: false,
      assets: [{
        id: 42,
        name: 'sru-field-0.4.0.apk',
        size: 70_000_000,
        url: 'https://api.github.com/repos/hfzndev/sru-field-app/releases/assets/42',
      }],
      ...release,
    },
  };
}

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    const body = JSON.stringify(payload());
    expect(verifySignature('s3cret', body, sign('s3cret', body))).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{"action":"published"}';
    expect(verifySignature('s3cret', body, sign('wrong', body))).toBe(false);
  });

  it('rejects a signature over a different body', () => {
    expect(verifySignature('s3cret', '{"a":1}', sign('s3cret', '{"a":2}'))).toBe(false);
  });

  // Returning false rather than throwing keeps the route's failure path single:
  // anything that is not a good signature is a 401, whatever shape it arrived in.
  it('rejects a missing, malformed, or non-string header', () => {
    expect(verifySignature('s3cret', '{}', '')).toBe(false);
    expect(verifySignature('s3cret', '{}', 'nonsense')).toBe(false);
    expect(verifySignature('s3cret', '{}', 'sha256=abc')).toBe(false);
    expect(verifySignature('s3cret', '{}', null)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(verifySignature('', '{}', sign('', '{}'))).toBe(false);
  });
});

describe('isPublishableRelease', () => {
  it('accepts a published, non-draft, non-prerelease v-tagged release', () => {
    expect(isPublishableRelease(payload())).toBe(true);
  });

  it('rejects drafts and prereleases', () => {
    expect(isPublishableRelease(payload({ draft: true }))).toBe(false);
    expect(isPublishableRelease(payload({ prerelease: true }))).toBe(false);
  });

  it('rejects actions other than published', () => {
    expect(isPublishableRelease({ ...payload(), action: 'edited' })).toBe(false);
    expect(isPublishableRelease({ ...payload(), action: 'deleted' })).toBe(false);
  });

  it('rejects tags that are not v<x.y.z>', () => {
    expect(isPublishableRelease(payload({ tag_name: '0.4.0' }))).toBe(false);
    expect(isPublishableRelease(payload({ tag_name: 'vabc' }))).toBe(false);
    expect(isPublishableRelease(payload({ tag_name: 'v0.4.0-rc1' }))).toBe(false);
    expect(isPublishableRelease(payload({ tag_name: undefined }))).toBe(false);
  });

  // GitHub sends a ping the moment the webhook is created, and it has no
  // `action` and no `release` at all. It must be ignored, not crash the route.
  it('rejects a ping payload and other junk without throwing', () => {
    expect(isPublishableRelease({ zen: 'Design for failure.', hook_id: 1 })).toBe(false);
    expect(isPublishableRelease(null)).toBe(false);
    expect(isPublishableRelease({ action: 'published' })).toBe(false);
  });
});

describe('releaseVersion', () => {
  it('strips the leading v so parseVersion can read it', () => {
    expect(releaseVersion(payload())).toBe('0.4.0');
  });

  it('returns null for a tag that is not v<x.y.z>', () => {
    expect(releaseVersion(payload({ tag_name: 'release-4' }))).toBeNull();
    expect(releaseVersion({})).toBeNull();
  });
});

describe('releaseAsset', () => {
  it('finds the asset whose name matches the tag version', () => {
    expect(releaseAsset(payload())).toMatchObject({ id: 42, name: 'sru-field-0.4.0.apk' });
  });

  // The tag is the only version source. An asset called sru-field-0.3.0.apk on
  // a v0.4.0 release is a mislabelled build, not a naming style to interpret.
  it('returns null when the asset name disagrees with the tag', () => {
    const p = payload({ assets: [{ id: 1, name: 'sru-field-0.3.0.apk' }] });
    expect(releaseAsset(p)).toBeNull();
  });

  it('returns null when there is no asset at all', () => {
    expect(releaseAsset(payload({ assets: [] }))).toBeNull();
    expect(releaseAsset(payload({ assets: undefined }))).toBeNull();
    expect(releaseAsset({})).toBeNull();
  });
});

describe('downloadAsset', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches the API asset url with an octet-stream Accept and returns the bytes', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(bytes.length) }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const buffer = await downloadAsset(releaseAsset(payload()), 'tok');

    expect(buffer).toEqual(bytes);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/hfzndev/sru-field-app/releases/assets/42');
    expect(options.headers.Accept).toBe('application/octet-stream');
    expect(options.headers.Authorization).toBe('Bearer tok');
    expect(options.redirect).toBe('follow');
  });

  it('omits the Authorization header when there is no token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(4),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await downloadAsset({ url: 'https://api.github.com/x', name: 'n' }, '');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('throws on an HTTP error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, headers: new Headers() }));
    await expect(downloadAsset({ url: 'u', name: 'n' }, 't')).rejects.toThrow(/404/);
  });

  it('throws when the declared length is over the cap, without reading the body', async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(300 * 1024 * 1024) }),
      arrayBuffer,
    }));

    await expect(downloadAsset({ url: 'u', name: 'n' }, 't')).rejects.toThrow(/besar/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  // A lying or absent content-length must not become a 300MB buffer in a
  // container sized for one small Next.js process.
  it('throws when the realised body is over the cap despite the header', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(201 * 1024 * 1024),
    }));

    await expect(downloadAsset({ url: 'u', name: 'n' }, 't')).rejects.toThrow(/besar/);
  });
});
