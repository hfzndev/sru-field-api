import { recordAction } from '@/lib/admin';
import { isApk, MAX_APK_BYTES, storeApk } from '@/lib/apk';
import { getDb } from '@/lib/db';
import {
  clientIp, errorResponse, MAX_JSON_BYTES, serverError, tooManyRequests,
} from '@/lib/http';
import {
  downloadAsset, isPublishableRelease, releaseAsset, releaseVersion, verifySignature,
} from '@/lib/github-release';
import { limitFor } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhook/apk-release — GitHub publishes a build for us.
 *
 * A release cut in `sru-field-app` with tag `v<x.y.z>` and an asset named
 * `sru-field-<x.y.z>.apk` lands in `data/apk/` here, and the handsets pick it up
 * from `/api/apk/latest`. The manual admin upload is unchanged and remains the
 * fallback; this only removes the step where a person pushes 67MB through a
 * browser form.
 *
 * This route is unauthenticated at the edge, which is why the gate is layered:
 * the HMAC signature is the control, and the body cap, the repository check, the
 * rate limit and the asset-size check are there so that everything short of the
 * secret is cheap to refuse.
 *
 * On why an inbound webhook is allowed here at all when AGENTS.md §3 says CI
 * cannot reach this host: that rule is about GitHub Actions runners, which
 * Cloudflare challenges and the firewall drops. A webhook travels
 * github.com → Cloudflare → nginx → container, and the WAF rule skipping the
 * Managed Challenge for `/api/*` already covers it. That is why this route lives
 * under `/api/` and not somewhere tidier.
 *
 * The status codes matter more than usual, because GitHub reads them: it retries
 * anything that is not 2xx and shows the delivery as failed until it succeeds.
 * So a delivery we simply do not want (a draft, another repo, no asset) answers
 * 200 with `ignored`, and only a genuinely retryable failure — the download —
 * answers 5xx.
 */
export async function POST(request) {
  const secret = process.env.APK_WEBHOOK_SECRET;
  if (!secret) {
    return errorResponse(503, 'WEBHOOK_NOT_CONFIGURED', 'Webhook APK belum dikonfigurasi');
  }

  const throttle = limitFor('general', clientIp(request));
  if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

  // A release payload is ~15KB. Anything near a megabyte is not one, and the
  // body has to be buffered whole to verify the signature over it.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_JSON_BYTES) {
    return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Payload webhook terlalu besar');
  }

  try {
    // Read as text, not readJson(): the signature covers the exact bytes, so
    // they must be hashed before anything reshapes them.
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_JSON_BYTES) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Payload webhook terlalu besar');
    }

    const signature = request.headers.get('x-hub-signature-256') ?? '';
    if (!verifySignature(secret, rawBody, signature)) {
      return errorResponse(401, 'INVALID_SIGNATURE', 'Tanda tangan webhook tidak valid');
    }

    if (request.headers.get('x-github-event') !== 'release') {
      // Includes the ping GitHub sends when the webhook is first saved, which is
      // the one delivery that proves this endpoint is reachable at all.
      return Response.json({ ok: true, ignored: 'event' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, 'VALIDATION_ERROR', 'Payload webhook bukan JSON valid');
    }

    const repo = process.env.APK_RELEASE_REPO;
    if (repo && payload?.repository?.full_name !== repo) {
      return Response.json({ ok: true, ignored: 'repository' });
    }

    if (!isPublishableRelease(payload)) {
      return Response.json({ ok: true, ignored: 'not_publishable' });
    }

    const asset = releaseAsset(payload);
    if (!asset) {
      return Response.json({ ok: true, ignored: 'no_asset' });
    }

    // An oversized asset is a build made without the ABI flag (doc APK-BUILD),
    // not a delivery that would succeed on retry — refused before the download.
    if (Number(asset.size ?? 0) > MAX_APK_BYTES) {
      return Response.json({ ok: true, ignored: 'too_large' });
    }

    const version = releaseVersion(payload);
    let buffer;
    try {
      buffer = await downloadAsset(asset, process.env.GITHUB_TOKEN);
    } catch (err) {
      console.error('apk webhook: unduhan asset gagal:', err.message);
      return errorResponse(502, 'DOWNLOAD_FAILED', 'Gagal mengunduh asset dari GitHub');
    }

    if (!isApk(buffer)) {
      return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Asset bukan APK (bukan arsip ZIP)');
    }

    let filename;
    try {
      filename = storeApk(buffer, version);
    } catch (err) {
      // GitHub redelivers. The same version arriving twice is the delivery
      // working, not failing — and the build already on disk is never replaced.
      if (err.code === 'EEXIST') {
        return Response.json({ ok: true, alreadyExists: `sru-field-${version}.apk` });
      }
      throw err;
    }

    // Audited like any other publish, under a username that says a machine did
    // it. No dataVersion bump: an APK is not pulled by delta.
    recordAction(getDb(), 'github-release', {
      action: 'UPLOAD',
      entity: 'apk',
      detail: `${filename} (${Math.round(buffer.length / 1024 / 1024)}MB, via release ${payload.release.tag_name})`,
    });

    return Response.json({ ok: true, stored: filename }, { status: 201 });
  } catch (err) {
    console.error('apk webhook gagal:', err);
    return serverError();
  }
}
