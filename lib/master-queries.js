import { toIso } from './time.js';

/**
 * Master-data queries that two callers must agree on.
 *
 * Login (lib/bootstrap.js) and delta pull (lib/pull.js) both build the phone's
 * master cache, and they must build the same one. They drifted: bootstrap's
 * equipment SELECT omitted unit_key and location, and because login stores the
 * server's current dataVersion as the pull cursor, the next delta contains only
 * rows that changed *after* login — so nothing ever went back to fill the gap.
 * A handset showed equipment with no location until an admin happened to edit
 * that row. Sharing the query is what stops that recurring.
 *
 * @see doc 06 §4 (bootstrap) and §5 (pull)
 */

/** How many readings per tank feed the tape suggestion (doc 02 §2.2). */
export const DEVIATION_SAMPLE_SIZE = 5;

/**
 * Equipment with the reason for its current status attached.
 *
 * Ordered by received_at rather than changed_at: changed_at holds ISO from a
 * handset and SQLite format from the admin route, and comparing those as text
 * ranks by the separator byte instead of by time.
 *
 * @param where SQL predicate over the alias `e`, e.g. `e.is_active = 1`
 */
export function equipmentSelect(where) {
  return `
    SELECT e.id, e.tag_number, e.name, e.unit_key, e.location, e.status, e.is_active,
           e.status_changed_at, l.description AS status_note, l.changed_by_name AS status_changed_by
      FROM equipment e
      LEFT JOIN equipment_status_log l
        ON l.id = (SELECT id FROM equipment_status_log
                    WHERE equipment_id = e.id
                    ORDER BY received_at DESC, id DESC LIMIT 1)
     WHERE ${where}
  `;
}

/** The wire shape. Both callers return exactly this, so the phone can store one. */
export function serializeEquipmentRow(e) {
  return {
    id: e.id,
    tagNumber: e.tag_number,
    name: e.name,
    unitKey: e.unit_key || '',
    location: e.location || '',
    status: e.status,
    statusNote: e.status_note || '',
    statusChangedBy: e.status_changed_by || '',
    statusChangedAt: toIso(e.status_changed_at),
    isActive: e.is_active === 1,
  };
}

/**
 * The last few readings per tank, feeding the phone's tape suggestion.
 *
 * Only readings carrying a DCS value: the phone averages (level − dcs), so a
 * reading whose DCS the operator could not read has no deviation in it and
 * would be dead weight over 2G.
 *
 * Deliberately NOT scoped by shift. Drift is a property of the tank, not of who
 * measured it, and doc 07 §5 calls this cache permanent rather than a rolling
 * window — the phone keeps 5 per tank regardless of age or shift.
 */
export function tankDeviation(db, tanks) {
  const statement = db.prepare(`
    SELECT level_mm, dcs_level_mm, reading_at
      FROM tank_readings
     WHERE tank_id = ? AND dcs_level_mm IS NOT NULL
     ORDER BY reading_at DESC
     LIMIT ?
  `);

  const result = {};
  for (const tank of tanks) {
    result[tank.id] = statement.all(tank.id, DEVIATION_SAMPLE_SIZE).map((r) => ({
      levelMm: r.level_mm,
      dcsLevelMm: r.dcs_level_mm,
      readingAt: toIso(r.reading_at),
    }));
  }
  return result;
}

/* ------------------------------------------------------------ lembar tugas */

/**
 * Which lembar tugas a handset may see (doc 05 §4).
 *
 * `assigned_shift = ''` means every shift; anything else is one group's display
 * name — the same string sync stamps onto records, so both sides agree without
 * a foreign key. Applied to columns, rows and cells through a join as well: a
 * phone holding a column whose sheet it never received would render a header
 * for a lembar it cannot open.
 */
const SHEET_VISIBLE = "(s.assigned_shift = '' OR s.assigned_shift = ?)";

/** Column `options` is a JSON array string; a malformed one degrades to none. */
function parseOptions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((o) => typeof o === 'string') : [];
  } catch {
    // Never throw: this runs inside pull, and one bad row must not cost the
    // handset every other table in the response.
    return [];
  }
}

/**
 * The lembar design — sheets, their columns, their rows.
 *
 * Shared by login and pull for exactly the reason this file exists. Login
 * stores the server's dataVersion as the pull cursor, so anything bootstrap
 * fails to send is not merely late — the next delta starts *after* it and the
 * gap never closes until a supervisor happens to edit that row.
 *
 * Rows are here even though operators create them. Once the server accepts a
 * row from one phone it is stamped (lib/sync.js handleSheetRow) and becomes
 * master to every other phone; there is no second channel.
 *
 * @param whereFor  (alias) => SQL predicate, e.g. `s.is_active = 1`
 * @param args      bound values for those predicates, in alias order s, c, r
 */
export function sheetBundle(db, shiftGroup, whereFor, args = []) {
  const sheets = db.prepare(`
    SELECT s.* FROM task_sheets s
     WHERE ${whereFor('s')} AND ${SHEET_VISIBLE}
     ORDER BY s.id
  `).all(...args, shiftGroup).map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description || '',
    status: s.status,
    dueDate: toIso(s.due_date),
    assignedShift: s.assigned_shift || '',
    allowOperatorRows: s.allow_operator_rows === 1,
    isActive: s.is_active === 1,
  }));

  const sheetColumns = db.prepare(`
    SELECT c.* FROM task_sheet_columns c
      JOIN task_sheets s ON s.id = c.sheet_id
     WHERE ${whereFor('c')} AND ${SHEET_VISIBLE}
     ORDER BY c.sheet_id, c.sort_order, c.id
  `).all(...args, shiftGroup).map((c) => ({
    id: c.id,
    sheetId: c.sheet_id,
    label: c.label,
    kind: c.kind,
    isRequired: c.is_required === 1,
    options: parseOptions(c.options),
    examplePhoto: c.example_photo || '',
    hint: c.hint || '',
    sortOrder: c.sort_order,
    isActive: c.is_active === 1,
  }));

  const sheetRows = db.prepare(`
    SELECT r.* FROM task_sheet_rows r
      JOIN task_sheets s ON s.id = r.sheet_id
     WHERE ${whereFor('r')} AND ${SHEET_VISIBLE}
     ORDER BY r.sheet_id, r.sort_order, r.id
  `).all(...args, shiftGroup).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    sheetId: r.sheet_id,
    label: r.label,
    sortOrder: r.sort_order,
    addedByName: r.added_by_name || '',
    isActive: r.is_active === 1,
  }));

  return { sheets, sheetColumns, sheetRows };
}

/**
 * The current value of every cell on every open lembar the caller can see.
 *
 * Deliberately NOT scoped to the caller's own shift, unlike the rest of the
 * 7-day window. A lembar is shared work: shift A photographs six pumps, shift B
 * picks up the other six, and the supervisor types a name into the admin grid.
 * If B could not see A's cells it would redo the whole walk.
 *
 * Cells are append-only (doc 07 §4), so "current" is the newest row per
 * (sheet, row, column). filled_at is an operator's clock and can tie or run
 * backwards between handsets, so id breaks the tie — the record the server saw
 * last wins, the same rule used everywhere else.
 */
export function sheetCellsFor(db, shiftGroup, limit) {
  return db.prepare(`
    SELECT c.* FROM task_sheet_cells c
      JOIN task_sheets s ON s.id = c.sheet_id
     WHERE s.is_active = 1 AND s.status = 'OPEN' AND ${SHEET_VISIBLE}
       AND c.id = (
         SELECT c2.id FROM task_sheet_cells c2
          WHERE c2.sheet_id = c.sheet_id AND c2.row_id = c.row_id AND c2.column_id = c.column_id
          ORDER BY c2.filled_at DESC, c2.id DESC LIMIT 1
       )
     ORDER BY c.sheet_id, c.row_id, c.column_id
     LIMIT ?
  `).all(shiftGroup, limit).map((c) => ({
    id: c.id,
    clientId: c.client_id,
    sheetId: c.sheet_id,
    rowId: c.row_id,
    columnId: c.column_id,
    valueText: c.value_text || '',
    valueNumber: c.value_number,
    photoPath: c.photo_path || '',
    filledByName: c.filled_by_name || '',
    shiftGroup: c.shift_group || '',
    shiftTime: c.shift_time || '',
    filledAt: toIso(c.filled_at),
    receivedAt: toIso(c.received_at),
  }));
}
