import { getDb } from './db.js';
import { errorResponse } from './http.js';
import { readCookie, readSession, SESSION_COOKIE } from './session.js';

/**
 * Admin surface helpers (doc 06 §6, doc 08 §3).
 *
 * Two rules hold for every admin mutation without exception:
 *   - it writes an `admin_actions` row, so there is always an answer to
 *     "who changed this and when";
 *   - if it touches master data it bumps and stamps `dataVersion`, or the
 *     change never reaches the handsets.
 *
 * Both are enforced by a sweep in test/admin.test.js that walks every mutating
 * route, rather than by trusting each one to remember.
 */

/**
 * @returns {{ok: true, username: string}|{ok: false}}
 */
export function requireAdmin(request) {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return { ok: false };

  const session = readSession(cookie);
  if (!session) return { ok: false };

  return { ok: true, username: session.username };
}

/** 401 for the admin surface — distinct message from the device one. */
export function adminUnauthorized() {
  return errorResponse(401, 'UNAUTHORIZED', 'Sesi admin tidak valid atau sudah berakhir');
}

export function notFound(message = 'Data tidak ditemukan') {
  return errorResponse(404, 'NOT_FOUND', message);
}

export function conflict(code, message) {
  return errorResponse(409, code, message);
}

/**
 * Appends to the audit trail (doc 08 §9). `detail` is a short human summary;
 * it must never carry a password or a token.
 */
export function recordAction(db, username, { action, entity, entityId = null, detail = '' }) {
  db.prepare(`
    INSERT INTO admin_actions (admin_username, action, entity, entity_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, action, entity, entityId, detail);
}

/**
 * Wraps an admin route: authenticates, then runs `handler(db, username)`.
 * Errors become a 500 without leaking driver messages.
 */
export async function withAdmin(request, handler) {
  const auth = requireAdmin(request);
  if (!auth.ok) return adminUnauthorized();

  try {
    return await handler(getDb(), auth.username);
  } catch (err) {
    console.error('admin route failed:', err);
    return errorResponse(500, 'SERVER_ERROR', 'Terjadi kesalahan di server');
  }
}

/** Route params arrive as a promise in Next 15+. */
export async function idParam(context) {
  const params = await context?.params;
  const id = Number(params?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function namedParam(context, name) {
  const params = await context?.params;
  const value = Number(params?.[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}
