import { recordAction, withAdmin } from '@/lib/admin';
import { CSV_COLUMNS, fetchFieldData } from '@/lib/admin-data';
import { csvResponse, toCsv } from '@/lib/csv';
import { validationError } from '@/lib/http';
import { dataQuerySchema, parse } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/data/export — doc 06 §6.
 *
 * Same query as the on-screen view, so an export always matches what the admin
 * was looking at. This is also the only sanctioned route for field data to
 * reach SRU APP (doc 04 §8), which is why the export is audited: it is the
 * moment data leaves this system.
 */
export async function GET(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);

  return withAdmin(request, (db, username) => {
    const parsed = parse(dataQuerySchema, params);
    if (!parsed.ok) return validationError(parsed.details);

    const query = { ...parsed.data, limit: Math.max(parsed.data.limit, 5000) };
    const rows = fetchFieldData(db, query);
    const csv = toCsv(CSV_COLUMNS[query.type], rows);

    recordAction(db, username, {
      action: 'EXPORT', entity: query.type,
      detail: `${rows.length} baris` + (query.from || query.to ? ` (${query.from || '…'} → ${query.to || '…'})` : ''),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return csvResponse(`sru-field-${query.type}-${stamp}.csv`, csv);
  });
}
