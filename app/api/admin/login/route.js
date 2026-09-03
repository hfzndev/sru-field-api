import { getDb } from '@/lib/db';
import { verifyPasswordConstantTime } from '@/lib/auth';
import { recordAction } from '@/lib/admin';
import { clientIp, readJson, serverError, tooManyRequests, validationError } from '@/lib/http';
import { checkLoginLockout, clearLoginFailures, limitFor, recordLoginFailure } from '@/lib/ratelimit';
import { createSession, serializeSessionCookie } from '@/lib/session';
import { adminLoginSchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/login — doc 06 §6.
 *
 * Rate limited harder than the device login (5 per 10 minutes, doc 08 §6):
 * the admin surface is reachable from a browser and is the higher-value target.
 */
export async function POST(request) {
  const ip = clientIp(request);
  const throttle = limitFor('adminLogin', ip);
  if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const parsed = parse(adminLoginSchema, body.data);
  if (!parsed.ok) return validationError(parsed.details);

  const { username, password } = parsed.data;

  const lockKey = `admin:${username}`;
  const lockout = checkLoginLockout(lockKey);
  if (lockout.locked) {
    return tooManyRequests(lockout.retryAfterSec, 'Terlalu banyak percobaan login gagal.');
  }

  try {
    const db = getDb();
    const admin = db.prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ?').get(username);

    // Same constant-time treatment as the device login: a missing admin account
    // must not answer faster than a wrong password.
    const passwordOk = await verifyPasswordConstantTime(password, admin?.password_hash);
    if (!admin || !passwordOk) {
      recordLoginFailure(lockKey);
      return Response.json(
        { error: { code: 'INVALID_CREDENTIALS', message: 'Username atau password salah' } },
        { status: 401 },
      );
    }

    clearLoginFailures(lockKey);
    recordAction(db, admin.username, { action: 'LOGIN', entity: 'admin', entityId: admin.id });

    const response = Response.json({ ok: true, username: admin.username });
    response.headers.append('Set-Cookie', serializeSessionCookie(createSession(admin.username)));
    return response;
  } catch (err) {
    console.error('admin login failed:', err);
    return serverError();
  }
}
