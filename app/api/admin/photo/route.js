import fs from 'node:fs';
import { notFound, withAdmin } from '@/lib/admin';
import { contentTypeFor, resolveStoredPhoto } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/photo?path=uploads/<uuid>.jpg — doc 06 §6.
 *
 * The admin equivalent of /api/photo, differing only in which credential it
 * accepts. It reuses the same resolver, so the traversal and filename guards
 * cannot drift between the two entry points — two hand-written copies of a
 * path check is how one of them ends up subtly weaker.
 */
export async function GET(request) {
  const requested = new URL(request.url).searchParams.get('path');

  return withAdmin(request, () => {
    const resolved = resolveStoredPhoto(requested);
    if (!resolved) return notFound('Foto tidak ditemukan');

    return new Response(fs.readFileSync(resolved), {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(resolved),
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });
}
