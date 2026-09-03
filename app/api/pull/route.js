import { getDb } from '@/lib/db';
import { authenticateDevice } from '@/lib/auth';
import { serverError, tooManyRequests, unauthorized } from '@/lib/http';
import { buildPull, parseSince } from '@/lib/pull';
import { limitFor } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pull?since=<dataVersion> — doc 06 §5.
 *
 * Returns master reference data changed since the caller's cursor, plus the
 * caller's own field records from the last 7 days. The phone stores the
 * returned `dataVersion` and sends it back as `since` on the next cycle.
 */
export async function GET(request) {
  try {
    const db = getDb();

    const auth = authenticateDevice(request, db);
    if (!auth.ok) return unauthorized();

    const throttle = limitFor('general', String(auth.token.id));
    if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

    const since = parseSince(new URL(request.url).searchParams.get('since'));

    return Response.json(buildPull(db, auth.account, since));
  } catch (err) {
    console.error('pull failed:', err);
    return serverError();
  }
}
