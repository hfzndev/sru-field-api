import { bumpDataVersion } from './dataversion.js';
import { toIso } from './time.js';

/**
 * Lembar tugas — shared reads for the admin surface (doc 05 §4).
 *
 * A lembar is a table a supervisor designs in the admin web: columns of a
 * chosen kind, rows naming the equipment to visit, and an example photo per
 * photo-column showing the operator what a correct shot looks like. Operators
 * fill it from the handset offline; the supervisor can fill cells too, from the
 * grid, so a name typed at the desk and a photo taken in the field land in the
 * same table.
 *
 * The read model is the awkward part and it lives here so the list route, the
 * detail route and the progress badge cannot disagree about what "filled"
 * means. Cells are append-only (doc 07 §4), so every read of a value is
 * "newest per (row, column)", never "the row".
 */

/** Columns an operator can actually put something in — LABEL is read-only text. */
export const FILLABLE_KINDS = new Set(['TEXT', 'NUMBER', 'PHOTO', 'CHECK', 'CHOICE']);

/**
 * Whether a cell counts as done.
 *
 * Per kind rather than "any column non-empty": a NUMBER of 0 is a real answer
 * and must not read as blank, while an empty string in the same place must.
 */
export function cellIsFilled(kind, cell) {
  if (!cell) return false;
  if (kind === 'PHOTO') return Boolean(cell.photoPath);
  if (kind === 'NUMBER') return cell.valueNumber !== null && cell.valueNumber !== undefined;
  return Boolean(cell.valueText);
}

export function serializeSheet(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    dueDate: toIso(row.due_date),
    assignedShift: row.assigned_shift || '',
    allowOperatorRows: row.allow_operator_rows === 1,
    isActive: row.is_active === 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function serializeColumn(row) {
  return {
    id: row.id,
    sheetId: row.sheet_id,
    label: row.label,
    kind: row.kind,
    isRequired: row.is_required === 1,
    options: parseOptions(row.options),
    examplePhoto: row.example_photo || '',
    hint: row.hint || '',
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
  };
}

export function serializeRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    sheetId: row.sheet_id,
    label: row.label,
    sortOrder: row.sort_order,
    addedByName: row.added_by_name || '',
    isActive: row.is_active === 1,
  };
}

export function serializeCell(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    sheetId: row.sheet_id,
    rowId: row.row_id,
    columnId: row.column_id,
    valueText: row.value_text || '',
    valueNumber: row.value_number,
    photoPath: row.photo_path || '',
    filledByName: row.filled_by_name || '',
    shiftGroup: row.shift_group || '',
    shiftTime: row.shift_time || '',
    filledAt: toIso(row.filled_at),
    receivedAt: toIso(row.received_at),
  };
}

/** `options` is stored as a JSON array string; a malformed one reads as none. */
export function parseOptions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((o) => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

export function activeColumns(db, sheetId) {
  return db.prepare(`
    SELECT * FROM task_sheet_columns
     WHERE sheet_id = ? AND is_active = 1 ORDER BY sort_order, id
  `).all(sheetId).map(serializeColumn);
}

export function activeRows(db, sheetId) {
  return db.prepare(`
    SELECT * FROM task_sheet_rows
     WHERE sheet_id = ? AND is_active = 1 ORDER BY sort_order, id
  `).all(sheetId).map(serializeRow);
}

/**
 * The current value of every cell on one lembar.
 *
 * Same correlated-subquery shape the handset pull uses
 * (lib/master-queries.js sheetCellsFor) so the grid and the phone agree on
 * which of two competing writes is showing. filled_at ties are broken by id:
 * whatever the server saw last wins.
 */
export function currentCells(db, sheetId) {
  return db.prepare(`
    SELECT c.* FROM task_sheet_cells c
     WHERE c.sheet_id = ?
       AND c.id = (
         SELECT c2.id FROM task_sheet_cells c2
          WHERE c2.sheet_id = c.sheet_id AND c2.row_id = c.row_id AND c2.column_id = c.column_id
          ORDER BY c2.filled_at DESC, c2.id DESC LIMIT 1
       )
     ORDER BY c.row_id, c.column_id
  `).all(sheetId).map(serializeCell);
}

/**
 * How much of a lembar is done, as `{ filled, total, rowsDone, rows }`.
 *
 * Only required fillable columns count toward `total`. Optional columns are
 * genuinely optional — counting them would leave a completed round showing
 * "10 of 14" forever, which teaches operators to ignore the number.
 *
 * `total` of 0 (a lembar with no required columns yet) is reported as such
 * rather than as 100%: the caller decides how to phrase "nothing to do".
 */
export function sheetProgress(columns, rows, cells) {
  const required = columns.filter((c) => c.isRequired && FILLABLE_KINDS.has(c.kind));
  const byKey = new Map(cells.map((cell) => [`${cell.rowId}:${cell.columnId}`, cell]));

  let filled = 0;
  let rowsDone = 0;
  for (const row of rows) {
    let done = 0;
    for (const column of required) {
      if (cellIsFilled(column.kind, byKey.get(`${row.id}:${column.id}`))) done += 1;
    }
    filled += done;
    if (required.length > 0 && done === required.length) rowsDone += 1;
  }

  return { filled, total: required.length * rows.length, rowsDone, rows: rows.length };
}

/** Sheet + design + current values + progress, the shape the admin grid renders. */
export function sheetDetail(db, sheetId) {
  const sheet = db.prepare('SELECT * FROM task_sheets WHERE id = ?').get(sheetId);
  if (!sheet) return null;

  const columns = activeColumns(db, sheetId);
  const rows = activeRows(db, sheetId);
  const cells = currentCells(db, sheetId);

  return {
    sheet: serializeSheet(sheet),
    columns,
    rows,
    cells,
    progress: sheetProgress(columns, rows, cells),
  };
}

/**
 * Stamps a whole lembar — the sheet row and every column and row under it —
 * with one new dataVersion.
 *
 * Not the same as stampMaster on the sheet alone, and the difference is a bug
 * waiting to happen: delta pull filters columns and rows by *their own*
 * data_version (lib/master-queries.js sheetBundle). A design whose sheet was
 * stamped but whose columns still read 0 arrives at a handset that already
 * pulled once as a sheet with no columns at all — a lembar the operator can
 * open and cannot fill.
 *
 * Cheap enough to do wholesale: a lembar is at most 12 columns and 200 rows,
 * and this runs when a supervisor edits, not on a hot path.
 *
 * Must be called inside a transaction (doc 07 §7).
 */
export function stampSheet(db, sheetId) {
  const version = bumpDataVersion(db);
  db.prepare("UPDATE task_sheets SET data_version = ?, updated_at = datetime('now') WHERE id = ?")
    .run(version, sheetId);
  db.prepare("UPDATE task_sheet_columns SET data_version = ?, updated_at = datetime('now') WHERE sheet_id = ?")
    .run(version, sheetId);
  db.prepare("UPDATE task_sheet_rows SET data_version = ?, updated_at = datetime('now') WHERE sheet_id = ?")
    .run(version, sheetId);
  return version;
}
