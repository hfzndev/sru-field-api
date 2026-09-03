import { withAdmin } from '@/lib/admin';
import { fetchFieldData } from '@/lib/admin-data';
import { validationError } from '@/lib/http';
import { dataQuerySchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/data — doc 06 §6.
 *
 * The Data Lapangan tab: read-only. Field records are never edited or deleted
 * from the server (doc 05 §3), so there is no mutating counterpart here.
 */
export async function GET(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);

  return withAdmin(request, (db) => {
    const parsed = parse(dataQuerySchema, params);
    if (!parsed.ok) return validationError(parsed.details);

    const rows = fetchFieldData(db, parsed.data);
    return Response.json({ type: parsed.data.type, count: rows.length, rows });
  });
}
