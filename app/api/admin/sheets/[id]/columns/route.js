import { idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { conflict } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import { activeColumns, serializeColumn, stampSheet } from '@/lib/sheets';
import { parse, sheetColumnSchema, SHEET_LIMITS } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** POST — appends a column to a published lembar. */
export async function POST(request, context) {
  const id = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!id) return notFound('Lembar tugas tidak ditemukan');
    const sheet = db.prepare('SELECT * FROM task_sheets WHERE id = ? AND is_active = 1').get(id);
    if (!sheet) return notFound('Lembar tugas tidak ditemukan');

    const existing = activeColumns(db, id);
    if (existing.length >= SHEET_LIMITS.columns) {
      return conflict(
        'SHEET_COLUMN_LIMIT',
        `Lembar tugas maksimal ${SHEET_LIMITS.columns} kolom`,
      );
    }

    const parsed = parse(sheetColumnSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);
    const column = parsed.data;

    const newId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO task_sheet_columns
          (sheet_id, label, kind, is_required, options, example_photo, hint, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, column.label, column.kind, column.isRequired ? 1 : 0,
        JSON.stringify(column.options), column.examplePhoto, column.hint,
        // Appended, never inserted mid-table: a column that shifts position
        // after operators have started filling makes their half-done rows read
        // as if they answered the wrong question.
        existing.length,
      );

      stampSheet(db, id);
      recordAction(db, username, {
        action: 'CREATE',
        entity: 'task_sheet_column',
        entityId: Number(info.lastInsertRowid),
        detail: `${sheet.title}: kolom ${column.label} (${column.kind})`,
      });
      return Number(info.lastInsertRowid);
    })();

    const row = db.prepare('SELECT * FROM task_sheet_columns WHERE id = ?').get(newId);
    return Response.json({ column: serializeColumn(row) }, { status: 201 });
  });
}
