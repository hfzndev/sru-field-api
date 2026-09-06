import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_APK_BYTES } from './apk.js';

/**
 * GitHub release webhook — the publishing half of an APK release (doc 09 §4).
 *
 * The build is still made by hand on a workstation, because the signing keystore
 * is deliberately not on a CI runner. What is automated here is only the last
 * step: a release cut in `sru-field-app` reaches this server without anyone
 * pushing 67MB through the admin form.
 *
 * Two things shape everything below.
 *
 *   The tag is the only version source. `v0.4.0` means 0.4.0 and nothing else is
 *   consulted — the same rule `lib/apk.js` applies to filenames. An asset whose
 *   name disagrees with its tag is a mislabelled build, and it is refused rather
 *   than stored under a guessed name.
 *
 *   The bytes are pulled, never pushed. nginx in front of this container caps a
 *   request body at 10MB (doc VPS-SETUP step 5), so an APK could not arrive
 *   inbound even if GitHub offered to send it. The webhook carries ~15KB of JSON
 *   and this module fetches the asset outbound from api.github.com.
 */

/** Release tags are `v` + the three-segment version `lib/apk.js` accepts. */
const TAG_VERSION = /^v(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/**
 * Verifies GitHub's `X-Hub-Signature-256`: HMAC-SHA256 over the exact request
 * bytes, hex, prefixed `sha256=`.
 *
 * Every malformed input returns false instead of throwing, so the route has one
 * failure path — not a good signature, therefore 401 — rather than a 401 branch
 * and a 500 branch that differ only in how the attacker shaped the header.
 * Compared in constant time: a byte-at-a-time compare leaks how much of a
 * guessed signature was right.
 */
export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== 'string' || !header) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');

  // timingSafeEqual throws on a length mismatch, and the length of a signature
  // is not a secret, so it is checked first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this delivery a release we should publish?
 *
 * Published, non-draft, non-prerelease only. A draft is a build still being
 * written up, and a prerelease is deliberately not for the handsets — either one
 * reaching `/api/apk/latest` would push itself to every phone in the plant.
 */
export function isPublishableRelease(payload) {
  if (!payload || payload.action !== 'published') return false;

  const release = payload.release;
  if (!release || release.draft || release.prerelease) return false;

  return TAG_VERSION.test(String(release.tag_name ?? ''));
}

/** The bare `x.y.z` from the tag — what `storeApk` and `parseVersion` expect. */
export function releaseVersion(payload) {
  const match = TAG_VERSION.exec(String(payload?.release?.tag_name ?? ''));
  return match ? match[1] : null;
}

/**
 * The one asset this release is allowed to publish, or null.
 *
 * Matched by exact name against the tag rather than by extension or by position.
 * A release carrying `sru-field-0.3.0.apk` under tag `v0.4.0` is a build that
 * was uploaded to the wrong release, and serving it as 0.4.0 would leave the
 * handsets updating forever to a version they already have.
 */
export function releaseAsset(payload) {
  const version = releaseVersion(payload);
  if (!version) return null;

  const expected = `sru-field-${version}.apk`;
  return (payload.release.assets ?? []).find((asset) => asset?.name === expected) ?? null;
}

/**
 * Downloads the asset bytes from the GitHub API.
 *
 * `asset.url` (the API url), not `browser_download_url`: the latter redirects to
 * object storage, and the redirect drops the Authorization header, so a private
 * repo answers 404. The token is omitted entirely when unset — a public repo
 * needs none, and sending `Bearer undefined` would fail a request that would
 * otherwise have worked.
 *
 * Throws rather than returning a sentinel: a failed download is retryable and
 * the route turns it into a 502 so GitHub redelivers with backoff.
 */
export async function downloadAsset(asset, token) {
  const headers = {
    Accept: 'application/octet-stream',
    'User-Agent': 'sru-field-api',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(asset.url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`unduhan asset GitHub gagal: HTTP ${response.status}`);
  }

  // Checked before reading the body, so an oversized asset costs a header round
  // trip instead of 300MB of heap in a container that runs one Next.js process.
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_APK_BYTES) throw new Error('APK terlalu besar (maksimal 200MB)');

  const buffer = Buffer.from(await response.arrayBuffer());
  // And again on what actually arrived: content-length may be absent or wrong.
  if (buffer.length > MAX_APK_BYTES) throw new Error('APK terlalu besar (maksimal 200MB)');

  return buffer;
}
