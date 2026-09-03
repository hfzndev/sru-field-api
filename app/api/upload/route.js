import { getDb } from '@/lib/db';
import { authenticateDevice } from '@/lib/auth';
import { errorResponse, serverError, tooManyRequests, unauthorized } from '@/lib/http';
import { limitFor } from '@/lib/ratelimit';
import { MAX_UPLOAD_BYTES, detectImageType, storeUpload } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/** Multipart framing adds a little to the declared length; allow for it. */
const MULTIPART_OVERHEAD = 4096;

/**
 * POST /api/upload — doc 06 §5.
 *
 * Photos are uploaded *before* the record that references them, so the path
 * comes back in time to be embedded in the sync payload (doc 07 §2). A file
 * uploaded whose record never arrives is an orphan: harmless, and swept weekly
 * (doc 09 §5).
 */
export async function POST(request) {
  try {
    const db = getDb();

    const auth = authenticateDevice(request, db);
    if (!auth.ok) return unauthorized();

    const throttle = limitFor('upload', String(auth.token.id));
    if (!throttle.allowed) return tooManyRequests(throttle.retryAfterSec);

    // Checked before parsing: formData() buffers the whole body, so an
    // oversized upload must be turned away before it is read into memory.
    // nginx's client_max_body_size is the outer guard in production (doc 09 §3).
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Foto terlalu besar (maksimal 5MB)');
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return errorResponse(400, 'VALIDATION_ERROR', 'Format upload tidak valid');
    }

    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return errorResponse(400, 'VALIDATION_ERROR', 'Field "file" wajib diisi');
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Foto terlalu besar (maksimal 5MB)');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Foto terlalu besar (maksimal 5MB)');
    }

    // The decisive check. The client's filename and Content-Type are both
    // ignored — only the bytes decide (doc 08 §7).
    const detected = detectImageType(buffer);
    if (!detected) {
      return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'File harus berupa foto JPEG, PNG, atau WebP');
    }

    return Response.json({ path: storeUpload(buffer, detected.ext) });
  } catch (err) {
    console.error('upload failed:', err);
    return serverError();
  }
}
