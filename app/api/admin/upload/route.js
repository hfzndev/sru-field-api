import { withAdmin } from '@/lib/admin';
import { readUploadedImage } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/upload — the admin equivalent of /api/upload (doc 06 §6).
 *
 * Exists for lembar tugas: a supervisor uploads the example photo that shows an
 * operator what a correct wide shot looks like, and fills photo cells from the
 * grid. The device route cannot serve that — it authenticates a handset token,
 * and an admin at a desk has a session cookie instead.
 *
 * Everything that makes an upload safe (size caps, magic-byte sniffing, the
 * server-generated filename) is in readUploadedImage, so the two entry points
 * cannot drift apart.
 *
 * No rate limit here, unlike the device route: an authenticated admin is a
 * named person at a keyboard with an audit trail, not an unattended handset on
 * a flaky link retrying in a loop.
 */
export async function POST(request) {
  return withAdmin(request, async () => {
    const result = await readUploadedImage(request);
    if (!result.ok) return result.response;
    return Response.json({ path: result.path });
  });
}
