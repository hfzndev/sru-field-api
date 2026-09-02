/**
 * Response helpers enforcing the error envelope from doc 06 §1:
 *   { "error": { "code": "...", "message": "...", "details": [...] } }
 *
 * `message` is Indonesian and shown directly to an operator, so it must stay
 * free of internal detail — no stack traces, no SQL, no hints about which half
 * of a credential was wrong.
 */

export function errorResponse(status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return Response.json({ error }, { status });
}

/** 400 — payload failed schema validation. */
export function validationError(details, message = 'Data yang dikirim tidak valid') {
  return errorResponse(400, 'VALIDATION_ERROR', message, details);
}

/** 401 — deliberately vague; never distinguishes bad user from bad password. */
export function unauthorized(message = 'Token tidak valid atau sudah dicabut') {
  return errorResponse(401, 'UNAUTHORIZED', message);
}

/** 429 — includes Retry-After so the phone can back off instead of hammering. */
export function tooManyRequests(retryAfterSec, message = 'Terlalu banyak percobaan. Coba lagi nanti.') {
  const body = { error: { code: 'RATE_LIMITED', message } };
  return Response.json(body, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
  });
}

export function serverError(message = 'Terjadi kesalahan di server') {
  return errorResponse(500, 'SERVER_ERROR', message);
}

/**
 * Best-effort client IP for rate-limit keys.
 *
 * Behind nginx + Cloudflare, x-forwarded-for is set by our own proxy and the
 * left-most entry is the real client. This header is spoofable if the app is
 * ever exposed directly, so it keys throttling only — never authorisation.
 */
export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
}

/** JSON body cap from doc 08 §6 — sync payloads are small by design. */
export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * Parses a JSON body with a size guard.
 * Returns { ok: true, data } or { ok: false, response } ready to return.
 */
export async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_JSON_BYTES) {
    return { ok: false, response: errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Data terlalu besar') };
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: validationError(undefined, 'Body permintaan tidak terbaca') };
  }

  // Content-Length can lie or be absent (chunked); check the real thing too.
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) {
    return { ok: false, response: errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Data terlalu besar') };
  }

  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, response: validationError(undefined, 'Format JSON tidak valid') };
  }
}
