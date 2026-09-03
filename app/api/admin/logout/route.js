import { serializeClearedCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/logout — doc 06 §6.
 *
 * Clears the cookie unconditionally. Sessions are stateless, so there is
 * nothing server-side to revoke; logging out of an already-expired session is
 * not an error worth reporting.
 */
export async function POST() {
  const response = Response.json({ ok: true });
  response.headers.append('Set-Cookie', serializeClearedCookie());
  return response;
}
