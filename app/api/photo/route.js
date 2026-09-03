import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { authenticateDevice } from '@/lib/auth';
import { errorResponse, serverError, unauthorized } from '@/lib/http';
import { readSession, SESSION_COOKIE } from '@/lib/session';
import { contentTypeFor, resolveStoredPhoto } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/**
 * Either credential opens a photo (doc 06 §7): a phone carries a device token,
 * the admin web carries a session cookie. Both are checked; neither is optional.
 */
function isAuthorised(request, db) {
  if (authenticateDevice(request, db).ok) return true;

  const cookie = request.cookies?.get?.(SESSION_COOKIE)?.value
    ?? parseCookieHeader(request.headers.get('cookie'))[SESSION_COOKIE];
  return cookie ? readSession(cookie) !== null : false;
}

function parseCookieHeader(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

/**
 * GET /api/photo?path=uploads/<uuid>.jpg — doc 06 §7.
 *
 * Files are stored outside the public directory precisely so that reaching them
 * requires passing through here.
 */
export async function GET(request) {
  try {
    const db = getDb();
    if (!isAuthorised(request, db)) return unauthorized();

    const requested = new URL(request.url).searchParams.get('path');

    // One response for "malformed", "traversal attempt" and "not there": a
    // probe learns nothing about what exists on disk.
    const resolved = resolveStoredPhoto(requested);
    if (!resolved) return errorResponse(404, 'NOT_FOUND', 'Foto tidak ditemukan');

    const file = fs.readFileSync(resolved);

    return new Response(file, {
      status: 200,
      headers: {
        // Fixed whitelist, derived from the extension this service generated —
        // not from anything the requester supplied.
        'Content-Type': contentTypeFor(resolved),
        // Stops a browser second-guessing the type and executing the payload.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err) {
    console.error('photo read failed:', err);
    return serverError();
  }
}
