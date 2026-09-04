import fs from 'node:fs';
import { authenticateDevice } from '@/lib/auth';
import { latestApk, resolveApk } from '@/lib/apk';
import { getDb } from '@/lib/db';
import { errorResponse, serverError, unauthorized } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/apk/latest — doc 06 §8.
 *
 * Two shapes, deliberately on one route:
 *
 *   HEAD asks "is there something newer" and costs nothing. The version is in
 *   a header, so a handset on a 2G link checks for an update without pulling
 *   70MB to find out the answer is no.
 *
 *   GET streams the build.
 *
 * Bearer-only. The admin cookie is not accepted here the way it is for photos:
 * an admin downloading a build does it from the admin page, which has its own
 * route, and every credential this endpoint accepts is another way for a
 * handset to be handed an installer.
 */
export async function GET(request) {
  return serve(request, { body: true });
}

export async function HEAD(request) {
  return serve(request, { body: false });
}

function serve(request, { body }) {
  try {
    const db = getDb();
    if (!authenticateDevice(request, db).ok) return unauthorized();

    const latest = latestApk();
    // Not an error state: a freshly deployed server has no build in its volume
    // yet, and the phone's update check must read that as "nothing new".
    if (!latest) return errorResponse(404, 'NOT_FOUND', 'Belum ada APK di server');

    const resolved = resolveApk(latest.filename);
    if (!resolved) return errorResponse(404, 'NOT_FOUND', 'Belum ada APK di server');

    const headers = {
      'Content-Type': 'application/vnd.android.package-archive',
      'X-App-Version': latest.version,
      'Content-Length': String(latest.bytes),
      'Content-Disposition': `attachment; filename="${latest.filename}"`,
      // A build is immutable once published (storeApk refuses to overwrite), so
      // it may be cached hard. What must not be cached is the *decision* that
      // this is the newest one, which is why the version rides in a header the
      // client re-reads on every check rather than in the body.
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    if (!body) return new Response(null, { status: 200, headers });

    return new Response(fs.readFileSync(resolved), { status: 200, headers });
  } catch (err) {
    console.error('apk download failed:', err);
    return serverError();
  }
}
