import crypto from 'node:crypto';

/**
 * Admin web session cookie (doc 08 §3).
 *
 * A signed, stateless cookie: `base64url(payload).base64url(hmac)`. The admin
 * surface is small and single-instance, so a server-side session table would be
 * state to manage for no benefit — but that means a cookie stays valid until it
 * expires, hence the deliberately short 8 hour lifetime.
 */

export const SESSION_COOKIE = 'admin_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SECRET_BYTES = 32;

/**
 * Read lazily, not at import time: the secret is only needed when an admin
 * actually signs in, and importing this module must not crash a container whose
 * device-facing API is otherwise fine.
 */
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || Buffer.byteLength(value, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(
      `SESSION_SECRET must be set to at least ${MIN_SECRET_BYTES} bytes ` +
      '(generate with: openssl rand -hex 32)',
    );
  }
  return value;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest();
}

/** Issues a signed cookie value for `username`. */
export function createSession(username, now = Date.now()) {
  const payload = { u: username, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
  const encoded = b64(JSON.stringify(payload));
  return `${encoded}.${b64(sign(encoded))}`;
}

/**
 * Verifies signature and expiry.
 * @returns {{username: string, exp: number}|null}
 */
export function readSession(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.includes('.')) return null;

  const [encoded, signature] = value.split('.', 2);
  if (!encoded || !signature) return null;

  let expected;
  let provided;
  try {
    expected = sign(encoded);
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }

  // Length check first: timingSafeEqual throws on a length mismatch, and that
  // throw would itself be an observable timing/behaviour difference.
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= now) return null;

  return { username: payload.u, exp: payload.exp };
}

/**
 * Cookie attributes (doc 08 §3). Secure is dropped outside production so the
 * admin UI is reachable over plain http on localhost during development; in the
 * container NODE_ENV is production and the flag is on.
 */
export function sessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Attributes that clear the cookie on logout. */
export function clearedSessionCookieOptions() {
  return { ...sessionCookieOptions(), maxAge: 0 };
}
