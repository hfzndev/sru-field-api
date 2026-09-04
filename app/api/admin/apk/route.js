import { conflict, recordAction, withAdmin } from '@/lib/admin';
import { MAX_APK_BYTES, isApk, listApks, parseVersion, storeApk } from '@/lib/apk';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Multipart framing adds a little to the declared length; allow for it. */
const MULTIPART_OVERHEAD = 4096;

/** GET — what builds the server is holding, newest first (doc 09 §3). */
export async function GET(request) {
  return withAdmin(request, () => Response.json({ apks: listApks() }));
}

/**
 * POST — publish a build (doc 09 §3 lapis 3).
 *
 * The version comes from the form field, not from the uploaded filename: a file
 * picked off a workstation may be called anything, and the name this server
 * stores it under is the name four handsets will trust.
 *
 * Nothing here reads the APK's own manifest to confirm the version matches. The
 * admin is stating which build this is, and the whole point of refusing to
 * overwrite is that the statement can be checked later — a mislabelled build
 * has to be superseded by a new version rather than silently corrected.
 */
export async function POST(request) {
  // Checked before parsing: formData() buffers the whole body, so an oversized
  // upload must be turned away before it is read into memory.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_APK_BYTES + MULTIPART_OVERHEAD) {
    return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'APK terlalu besar (maksimal 200MB)');
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'VALIDATION_ERROR', 'Format upload tidak valid');
  }

  return withAdmin(request, async (db, username) => {
    const version = form.get('version');
    if (!parseVersion(version)) {
      return errorResponse(400, 'VALIDATION_ERROR', 'Versi harus berbentuk x.y.z');
    }

    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return errorResponse(400, 'VALIDATION_ERROR', 'Field "file" wajib diisi');
    }
    if (file.size > MAX_APK_BYTES) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'APK terlalu besar (maksimal 200MB)');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_APK_BYTES) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'APK terlalu besar (maksimal 200MB)');
    }

    // The bytes decide, not the filename or the Content-Type — same rule as
    // photo upload (doc 08 §7). An APK is a ZIP; anything else is refused
    // before it can be handed to a handset as an installer.
    if (!isApk(buffer)) {
      return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'File bukan APK (bukan arsip ZIP)');
    }

    let filename;
    try {
      filename = storeApk(buffer, String(version));
    } catch (err) {
      // 'wx' fails when the version already exists. Replacing a published
      // build in place would leave some handsets on one 0.3.0 and some on
      // another, with nothing to tell them apart.
      if (err.code === 'EEXIST') {
        return conflict('VERSION_EXISTS', `Versi ${version} sudah ada — naikkan versinya`);
      }
      throw err;
    }

    recordAction(db, username, {
      action: 'UPLOAD', entity: 'apk',
      detail: `${filename} (${Math.round(buffer.length / 1024 / 1024)}MB)`,
    });

    return Response.json({ apks: listApks() }, { status: 201 });
  });
}