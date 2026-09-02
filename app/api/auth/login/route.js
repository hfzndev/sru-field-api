import { getDb } from '@/lib/db';
import { buildBootstrap } from '@/lib/bootstrap';
import { mintToken, usernameToShiftCode, verifyPasswordConstantTime } from '@/lib/auth';
import { clientIp, readJson, serverError, tooManyRequests, validationError } from '@/lib/http';
import { checkLoginLockout, clearLoginFailures, limitFor, recordLoginFailure } from '@/lib/ratelimit';
import { loginSchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * One message for every credential failure. Distinguishing "no such user" from
 * "wrong password" hands an attacker a free username oracle (doc 06 §4).
 */
const GENERIC_CREDENTIAL_ERROR = 'Username atau password salah';

function credentialsRejected() {
  return Response.json(
    { error: { code: 'INVALID_CREDENTIALS', message: GENERIC_CREDENTIAL_ERROR } },
    { status: 401 },
  );
}

/**
 * POST /api/auth/login — doc 06 §4.
 *
 * Returns a device token *and* the full bootstrap bundle in one response:
 * login is typically the only moment an operator has signal, so the phone must
 * leave with everything it needs for the rest of the shift.
 */
export async function POST(request) {
  const throttle = limitFor('login', clientIp(request));
  if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const parsed = parse(loginSchema, body.data);
  if (!parsed.ok) return validationError(parsed.details);

  const { username, password, deviceName, appVersion } = parsed.data;

  // Checked before any bcrypt work: a locked-out username should cost nothing
  // and reveal nothing through response timing.
  const lockout = checkLoginLockout(username);
  if (lockout.locked) {
    return tooManyRequests(
      lockout.retryAfterSec,
      'Terlalu banyak percobaan login gagal. Coba lagi dalam beberapa menit.',
    );
  }

  try {
    const db = getDb();
    const account = db.prepare(`
      SELECT id, code, display_name, password_hash, is_active
        FROM shift_accounts WHERE code = ?
    `).get(usernameToShiftCode(username));

    // An inactive account is treated exactly like a wrong password: the caller
    // learns only that these credentials do not work.
    const usable = account && account.is_active === 1 ? account : null;
    const passwordOk = await verifyPasswordConstantTime(password, usable?.password_hash);

    if (!usable || !passwordOk) {
      recordLoginFailure(username);
      return credentialsRejected();
    }

    clearLoginFailures(username);

    const { token, tokenHash } = mintToken();

    // Issue and revoke together: if the insert fails, the previous token must
    // stay valid rather than leaving the device with no way back in.
    db.transaction(() => {
      // One live session per physical device (doc 08 §2.5). Scoped to
      // device_name so signing in on HP-2 does not sign HP-1 out mid-shift.
      db.prepare(`
        UPDATE device_tokens
           SET revoked_at = datetime('now')
         WHERE shift_account_id = ? AND device_name = ? AND revoked_at IS NULL
      `).run(usable.id, deviceName);

      db.prepare(`
        INSERT INTO device_tokens
          (shift_account_id, token_hash, device_name, app_version, last_seen_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(usable.id, tokenHash, deviceName, appVersion);
    })();

    return Response.json({ token, ...buildBootstrap(db, usable) });
  } catch (err) {
    // Never let a driver message reach the client — it can carry schema detail.
    console.error('login failed:', err);
    return serverError();
  }
}
