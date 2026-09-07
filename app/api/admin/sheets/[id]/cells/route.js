import { randomUUID } from 'node:crypto';
import { conflict, idParam, notFound, recordAction, withAdmin } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import { currentCells, FILLABLE_KINDS } from '@/lib/sheets';
import { nowIso } from '@/lib/time';
import { parse, sheetCellAdminSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * POST — the supervisor fills a cell from the admin grid (doc 05 §4).
 *
 * The same table the handset writes to, through the same append-only rule:
 * this inserts a new cell rather than updating one, so an admin correction and
 * an operator's original reading both survive and the later `filled_at` is what
 * the grid and the phone show. A blank value is a legitimate write — it is how
 * a cell gets cleared, and it stays visible as a deliberate act rather than
 * looking like the operator never got there.
 *
 * No dataVersion stamp: cells are field data, not master. They reach handsets
 * through the `recent` half of pull, which is sent whole every time
 * (lib/master-queries.js sheetCellsFor).
 */
export async function POST(request, context) {
  const sheetId = await idParam(context);
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    if (!sheetId) return notFound('Lembar tugas tidak ditemukan');
    const sheet = db.prepare('SELECT * FROM task_sheets WHERE id = ? AND is_active = 1').get(sheetId);
    if (!sheet) return notFound('Lembar tugas tidak ditemukan');

    const parsed = parse(sheetCellAdminSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);
    const { rowId, columnId, valueText, valueNumber, photoPath } = parsed.data;

    const row = db.prepare('SELECT id, label FROM task_sheet_rows WHERE id = ? AND sheet_id = ?')
      .get(rowId, sheetId);
    if (!row) return notFound('Baris tidak ditemukan');

    const column = db.prepare('SELECT id, label, kind FROM task_sheet_columns WHERE id = ? AND sheet_id = ?')
      .get(columnId, sheetId);
    if (!column) return notFound('Kolom tidak ditemukan');
    if (!FILLABLE_KINDS.has(column.kind)) {
      return conflict('SHEET_COLUMN_NOT_FILLABLE', 'Kolom keterangan tidak bisa diisi');
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO task_sheet_cells
          (client_id, sheet_id, row_id, column_id, value_text, value_number, photo_path,
           filled_by_name, shift_group, shift_time, filled_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, datetime('now'))
      `).run(
        // Minted here so an admin-written cell is addressable exactly like one
        // that came off a handset — nothing downstream has to branch on origin.
        randomUUID(), sheetId, rowId, columnId, valueText, valueNumber, photoPath,
        username, nowIso(),
      );

      recordAction(db, username, {
        action: 'UPDATE', entity: 'task_sheet_cell', entityId: sheetId,
        detail: `${sheet.title}: ${row.label} / ${column.label}`,
      });
    })();

    return Response.json({ cells: currentCells(db, sheetId) }, { status: 201 });
  });
}
