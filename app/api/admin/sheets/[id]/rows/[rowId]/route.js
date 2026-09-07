import { idParam, namedParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import { serializeRow, stampSheet } from '@/lib/sheets';
import { parse, sheetRowAdminSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function loadRow(db, sheetId, rowId) {
  return db.prepare('SELECT * FROM task_sheet_rows WHERE id = ? AND sheet_id = ?').get(rowId, sheetId);
}

/** PUT — renames a row (the equipment tag the operator is looking for). */
export async function PUT(request, context) {
  const sheetId = await idParam(context);
  const rowId = await namedParam(context, 'rowId');
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!sheetId || !rowId) return notFound('Baris tidak ditemukan');
    const existing = loadRow(db, sheetId, rowId);
    if (!existing) return notFound('Baris tidak ditemukan');

    const parsed = parse(sheetRowAdminSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    db.transaction(() => {
      db.prepare('UPDATE task_sheet_rows SET label = ?, is_active = ? WHERE id = ?')
        .run(parsed.data.label, parsed.data.isActive ? 1 : 0, rowId);
      stampSheet(db, sheetId);
      recordAction(db, username, {
        action: 'UPDATE', entity: 'task_sheet_row', entityId: rowId,
        detail: existing.label === parsed.data.label
          ? parsed.data.label
          : `${existing.label} → ${parsed.data.label}`,
      });
    })();

    return Response.json({ row: serializeRow(loadRow(db, sheetId, rowId)) });
  });
}

/** DELETE — soft delete; the cells filled against this row are kept. */
export async function DELETE(request, context) {
  const sheetId = await idParam(context);
  const rowId = await namedParam(context, 'rowId');

  return withAdmin(request, (db, username) => {
    if (!sheetId || !rowId) return notFound('Baris tidak ditemukan');
    const existing = loadRow(db, sheetId, rowId);
    if (!existing) return notFound('Baris tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE task_sheet_rows SET is_active = 0 WHERE id = ?').run(rowId);
      stampSheet(db, sheetId);
      recordAction(db, username, {
        action: 'DELETE', entity: 'task_sheet_row', entityId: rowId, detail: existing.label,
      });
    })();

    return Response.json({ ok: true });
  });
}
