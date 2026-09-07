import { getDb } from '@/lib/db';
import { authenticateDevice } from '@/lib/auth';
import { serverError, tooManyRequests, unauthorized } from '@/lib/http';
import { limitFor } from '@/lib/ratelimit';
import { readUploadedImage } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/**
 * POST /api/upload — doc 06 §5.
 *
 * Photos are uploaded *before* the record that references them, so the path
 * comes back in time to be embedded in the sync payload (doc 07 §2). A file
 * uploaded whose record never arrives is an orphan: harmless, and swept weekly
 * (doc 09 §5).
 *
 * The parsing and the format checks live in lib/uploads.js, shared with the
 * admin route; this one owns only the device credential and the throttle.
 */
export async function POST(request) {
  try {
    const db = getDb();

    const auth = authenticateDevice(request, db);
    if (!auth.ok) return unauthorized();

    const throttle = limitFor('upload', String(auth.token.id));
    if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

    const result = await readUploadedImage(request);
    if (!result.ok) return result.response;

    return Response.json({ path: result.path });
  } catch (err) {
    console.error('upload failed:', err);
    return serverError();
  }
}
