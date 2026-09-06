import fs from 'node:fs';
import { notFound, withAdmin } from '@/lib/admin';
import { resolveApk } from '@/lib/apk';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/apk/<filename> — doc 06 §8.
 *
 * The admin's own way to a build, and the reason /api/apk/latest can stay
 * Bearer-only: every credential that route accepts is another way a handset
 * could be handed an installer, so the admin is served from a separate door
 * rather than by widening that one.
 *
 * It takes a filename rather than serving "latest" because the two callers want
 * different things. A handset wants whatever is newest; an admin is usually
 * after a *specific* build — the one a phone in their hand is complaining
 * about, or the previous one they need to sideload to reproduce a bug.
 *
 * `resolveApk` is the same resolver the device route uses: the naming rule, the
 * traversal check and the symlink exclusion cannot drift between the two entry
 * points, which is how one of two hand-written copies ends up weaker.
 *
 * Not recorded in `admin_actions`: the audit trail is for changes, and reading
 * a build changes nothing.
 */
export async function GET(request, context) {
  const params = await context?.params;
  const filename = typeof params?.filename === 'string' ? params.filename : '';

  return withAdmin(request, () => {
    const resolved = resolveApk(filename);
    if (!resolved) return notFound('APK tidak ditemukan');

    const stat = fs.statSync(resolved);

    return new Response(fs.readFileSync(resolved), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': String(stat.size),
        // attachment, not inline: a browser that decides to render 70MB of ZIP
        // as text is a hung tab, and the file is only ever wanted on disk.
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
