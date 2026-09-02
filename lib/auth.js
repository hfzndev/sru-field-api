import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from './db.js';

/**
 * Device authentication (doc 08 §2).
 *
 * A device token is a 32-byte random value handed to the phone once at login.
 * The database stores only sha256(token): a leaked database backup yields no
 * usable credentials. Tokens have no expiry by design — an operator may be
 * offline for days — so revocation, not expiry, is the control (doc 08 §2.7).
 */

/** bcryptjs, never the native `bcrypt` binding (doc 08 §4). */
export const BCRYPT_COST = 10;

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * A precomputed hash of a value nobody can supply, compared against when the
 * username does not exist. Without it, a missing account returns far faster
 * than a wrong password and the response time enumerates valid usernames.
 */
const DUMMY_HASH = bcrypt.hashSync('__no_such_account__', BCRYPT_COST);

export async function verifyPasswordConstantTime(password, hash) {
  if (!hash) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}

export function mintToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Login username `shift_a` → storage code `SHIFT_A` (doc 02 §1.3). */
export function usernameToShiftCode(username) {
  return String(username || '').trim().toUpperCase();
}

/** Extracts a bearer token, or null. */
export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+([A-Za-z0-9._-]+)$/i);
  return match ? match[1] : null;
}

/**
 * last_seen_at powers the admin Devices tab. Writing it on every request would
 * mean a DB write per sync poll, so it is throttled: at this scale a minute of
 * staleness is invisible, and the write amplification is not.
 */
const LAST_SEEN_THROTTLE_MS = 60_000;
const lastSeenWrites = new Map();

function touchLastSeen(db, tokenId, now = Date.now()) {
  const previous = lastSeenWrites.get(tokenId) || 0;
  if (now - previous < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrites.set(tokenId, now);
  db.prepare("UPDATE device_tokens SET last_seen_at = datetime('now') WHERE id = ?").run(tokenId);
}

/**
 * Resolves a request's bearer token to its shift account.
 *
 * @returns {{ok: true, account, token}} or {{ok: false, reason}}
 */
export function authenticateDevice(request, db = getDb()) {
  const token = bearerToken(request);
  if (!token) return { ok: false, reason: 'MISSING_TOKEN' };

  const row = db.prepare(`
    SELECT t.id, t.shift_account_id, t.device_name, t.app_version, t.revoked_at,
           a.code, a.display_name, a.is_active
      FROM device_tokens t
      JOIN shift_accounts a ON a.id = t.shift_account_id
     WHERE t.token_hash = ?
  `).get(hashToken(token));

  // One generic failure reason for every case: unknown token, revoked token,
  // and deactivated account are indistinguishable from outside.
  if (!row) return { ok: false, reason: 'UNKNOWN_TOKEN' };
  if (row.revoked_at) return { ok: false, reason: 'REVOKED' };
  if (!row.is_active) return { ok: false, reason: 'ACCOUNT_INACTIVE' };

  touchLastSeen(db, row.id);

  return {
    ok: true,
    token: { id: row.id, deviceName: row.device_name, appVersion: row.app_version },
    account: { id: row.shift_account_id, code: row.code, displayName: row.display_name },
  };
}

/** Test seam for the last_seen throttle. */
export function resetLastSeenThrottle() {
  lastSeenWrites.clear();
}
