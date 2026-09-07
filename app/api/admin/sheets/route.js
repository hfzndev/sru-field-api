import { randomUUID } from 'node:crypto';
import { recordAction, withAdmin } from '@/lib/admin';
import { readJson, validationError } from '@/lib/http';
import {
  activeColumns, activeRows, currentCells, serializeSheet, sheetProgress, stampSheet,
} from '@/lib/sheets';
import { parse, sheetSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * Lembar tugas — list and create (doc 06 §6).
 *
 * This is the supervisor's half of the feature: designing the table. The
 * operator's half is sync (lib/sync.js) and the handset screens.
 */

/**
 * GET — every lembar with its completion counts.
 *
 * The progress numbers are computed per sheet rather than in one aggregate
 * query. With cells append-only the "current value" is already a correlated
 * subquery, and volume here is a handful of sheets — a clever single query
 * would be harder to keep in step with the grid's definition of "filled"
 * (lib/sheets.js) for no measurable gain.
 */
export async function GET(request) {
  return withAdmin(request, (db) => {
    const sheets = db.prepare('SELECT * FROM task_sheets WHERE is_active = 1 ORDER BY id DESC')
      .all()
      .map((row) => ({
        ...serializeSheet(row),
        progress: sheetProgress(
          activeColumns(db, row.id), activeRows(db, row.id), currentCells(db, row.id),
        ),
      }));

    return Response.json({ sheets });
  });
}

/**
 * POST — creates a lembar with its columns and rows in one request.
 *
 * Deliberately one request and one transaction. A sheet published with its
 * columns but not its rows is the failure an operator would actually hit: they
 * open a lembar with headers and nothing to walk, and there is no way for them
 * to tell that from a lembar the supervisor genuinely left empty.
 */
export async function POST(request) {
  const body = await readJson(request);
  if (!body.ok) return body.response;

  return withAdmin(request, (db, username) => {
    const parsed = parse(sheetSchema, body.data);
    if (!parsed.ok) return validationError(parsed.details);

    const {
      title, description, status, dueDate, assignedShift, allowOperatorRows, columns, rows,
    } = parsed.data;

    const admin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);

    const id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO task_sheets
          (title, description, status, due_date, assigned_shift, allow_operator_rows, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        title, description, status, dueDate, assignedShift,
        allowOperatorRows ? 1 : 0, admin?.id ?? null,
      );
      const sheetId = Number(info.lastInsertRowid);

      insertColumns(db, sheetId, columns);
      insertRows(db, sheetId, rows, 'admin');

      // One version across the sheet, its columns and its rows — stampSheet
      // explains why stamping the sheet alone would ship a headerless lembar.
      stampSheet(db, sheetId);
      recordAction(db, username, {
        action: 'CREATE',
        entity: 'task_sheet',
        entityId: sheetId,
        detail: `${title} (${columns.length} kolom, ${rows.length} baris)`,
      });
      return sheetId;
    })();

    return Response.json({ sheet: serializeSheet(db.prepare('SELECT * FROM task_sheets WHERE id = ?').get(id)) }, { status: 201 });
  });
}

/**
 * Writes the column list, stamping each with the version the caller already
 * bumped. Callers must be inside a transaction that also stamps the sheet.
 */
export function insertColumns(db, sheetId, columns) {
  const statement = db.prepare(`
    INSERT INTO task_sheet_columns
      (sheet_id, label, kind, is_required, options, example_photo, hint, sort_order, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  columns.forEach((column, index) => {
    statement.run(
      sheetId, column.label, column.kind, column.isRequired ? 1 : 0,
      JSON.stringify(column.options ?? []), column.examplePhoto, column.hint,
      // The array's order is the truth. A builder that lets the supervisor drag
      // rows around should not also have to keep a sortOrder field honest.
      column.sortOrder || index, column.isActive === false ? 0 : 1,
    );
  });
}

export function insertRows(db, sheetId, rows, addedByName) {
  const last = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS last FROM task_sheet_rows WHERE sheet_id = ?',
  ).get(sheetId).last;

  const statement = db.prepare(`
    INSERT INTO task_sheet_rows (client_id, sheet_id, label, sort_order, added_by_name)
    VALUES (?, ?, ?, ?, ?)
  `);

  return rows.map((row, index) => {
    // Rows created here carry a client_id too, even though nothing offline
    // minted one. It costs nothing and it means the handset can address every
    // row the same way, rather than branching on where the row came from.
    const info = statement.run(randomUUID(), sheetId, row.label, last + 1 + index, addedByName);
    return Number(info.lastInsertRowid);
  });
}
