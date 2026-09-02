import { getDb } from '@/lib/db';
import { authenticateDevice } from '@/lib/auth';
import { serverError, unauthorized } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/revoke — doc 06 §4.
 *
 * Logout. Revoking is idempotent by construction: the token is already invalid
 * on a second call, so it simply fails authentication.
 */
export async function POST(request) {
  try {
    const db = getDb();
    const auth = authenticateDevice(request, db);
    if (!auth.ok) return unauthorized();

    db.prepare("UPDATE device_tokens SET revoked_at = datetime('now') WHERE id = ?")
      .run(auth.token.id);

    return Response.json({ ok: true });
  } catch (err) {
    console.error('revoke failed:', err);
    return serverError();
  }
}
