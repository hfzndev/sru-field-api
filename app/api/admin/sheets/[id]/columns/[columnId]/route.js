import { idParam, namedParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import { serializeColumn, stampSheet } from '@/lib/sheets';
import { parse, sheetColumnSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function loadColumn(db, sheetId, columnId) {
  return db.prepare('SELECT * FROM task_sheet_columns WHERE id = ? AND sheet_id = ?')
    .get(columnId, sheetId);
}

/** PUT — edits a column in place. `kind` may change; existing cells are kept. */
export async function PUT(request, context) {
  const sheetId = await idParam(context);
  const columnId = await namedParam(context, 'columnId');
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!sheetId || !columnId) return notFound('Kolom tidak ditemukan');
    const existing = loadColumn(db, sheetId, columnId);
    if (!existing) return notFound('Kolom tidak ditemukan');

    const parsed = parse(sheetColumnSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);
    const column = parsed.data;

    db.transaction(() => {
      // sort_order is not editable here. Reordering a live lembar is a separate
      // decision with a separate consequence for half-filled rows, and folding
      // it into an edit would make it happen by accident.
      db.prepare(`
        UPDATE task_sheet_columns
           SET label = ?, kind = ?, is_required = ?, options = ?, example_photo = ?,
               hint = ?, is_active = ?
         WHERE id = ?
      `).run(
        column.label, column.kind, column.isRequired ? 1 : 0, JSON.stringify(column.options),
        column.examplePhoto, column.hint, column.isActive ? 1 : 0, columnId,
      );

      stampSheet(db, sheetId);
      recordAction(db, username, {
        action: 'UPDATE', entity: 'task_sheet_column', entityId: columnId,
        detail: `kolom ${column.label}`,
      });
    })();

    return Response.json({ column: serializeColumn(loadColumn(db, sheetId, columnId)) });
  });
}

/** DELETE — soft delete, so cells already filled under it survive. */
export async function DELETE(request, context) {
  const sheetId = await idParam(context);
  const columnId = await namedParam(context, 'columnId');

  return withAdmin(request, (db, username) => {
    if (!sheetId || !columnId) return notFound('Kolom tidak ditemukan');
    const existing = loadColumn(db, sheetId, columnId);
    if (!existing) return notFound('Kolom tidak ditemukan');

    db.transaction(() => {
      db.prepare('UPDATE task_sheet_columns SET is_active = 0 WHERE id = ?').run(columnId);
      stampSheet(db, sheetId);
      recordAction(db, username, {
        action: 'DELETE', entity: 'task_sheet_column', entityId: columnId,
        detail: `kolom ${existing.label}`,
      });
    })();

    return Response.json({ ok: true });
  });
}
