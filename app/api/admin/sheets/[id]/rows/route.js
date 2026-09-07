import { conflict, idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import { activeRows, stampSheet } from '@/lib/sheets';
import { parse, sheetRowAdminSchema, SHEET_LIMITS } from '@/lib/validation';
import { z } from 'zod';
import { insertRows } from '../../route.js';

export const dynamic = 'force-dynamic';

/**
 * The builder's fast path: a supervisor pastes twelve pump tags, one per line,
 * rather than clicking "add row" twelve times. The browser splits the text; this
 * accepts either shape so a single-row add is not a special case.
 */
const rowsSchema = z.object({
  rows: z.array(sheetRowAdminSchema).min(1).max(SHEET_LIMITS.rows),
});

export async function POST(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Lembar tugas tidak ditemukan');
    const sheet = db.prepare('SELECT * FROM task_sheets WHERE id = ? AND is_active = 1').get(id);
    if (!sheet) return notFound('Lembar tugas tidak ditemukan');

    const parsed = parse(rowsSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const existing = activeRows(db, id);
    if (existing.length + parsed.data.rows.length > SHEET_LIMITS.rows) {
      return conflict('SHEET_ROW_LIMIT', `Lembar tugas maksimal ${SHEET_LIMITS.rows} baris`);
    }

    db.transaction(() => {
      insertRows(db, id, parsed.data.rows, 'admin');
      stampSheet(db, id);
      recordAction(db, username, {
        action: 'CREATE', entity: 'task_sheet_row', entityId: id,
        detail: `${sheet.title}: +${parsed.data.rows.length} baris`,
      });
    })();

    return Response.json({ rows: activeRows(db, id) }, { status: 201 });
  });
}
