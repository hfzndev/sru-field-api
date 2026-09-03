import { getDb } from '@/lib/db';
import { authenticateDevice } from '@/lib/auth';
import { clientIp, readJson, serverError, tooManyRequests, unauthorized, validationError } from '@/lib/http';
import { limitFor } from '@/lib/ratelimit';
import { isEmptyPayload, processSync } from '@/lib/sync';
import { parse, syncSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync — doc 06 §5.
 *
 * Push endpoint for everything captured offline. Returns per-record outcomes:
 * `acked` (committed), `duplicates` (already held — safe, not an error), and
 * `errors` (rejected on domain grounds). The phone marks a record SYNCED only
 * on ack or duplicate; anything in `errors` stays on the device with a message
 * for the operator (doc 07 §2.3).
 */
export async function POST(request) {
  try {
    const db = getDb();

    const auth = authenticateDevice(request, db);
    if (!auth.ok) return unauthorized();

    // Keyed on the device token: one phone syncing hard must not throttle the
    // other two sharing the shift account.
    const throttle = limitFor('sync', String(auth.token.id));
    if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

    const body = await readJson(request);
    if (!body.ok) return body.response;

    // A malformed clientId fails the whole request rather than one record: the
    // phone mints those itself, so it is our bug to fix, not data to tolerate
    // (doc 10 §2.2).
    const parsed = parse(syncSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    if (isEmptyPayload(parsed.data)) {
      return validationError(undefined, 'Tidak ada data untuk disinkronkan');
    }

    return Response.json(processSync(db, parsed.data));
  } catch (err) {
    // The transaction has rolled back, so nothing landed and the phone still
    // holds every record. Retrying is safe by construction.
    console.error('sync failed:', err);
    return serverError();
  }
}
