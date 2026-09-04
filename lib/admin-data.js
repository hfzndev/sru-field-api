import { isoToSqlite, toIso } from './time.js';

/**
 * Field-data browsing for the admin Data Lapangan tab (doc 06 §6, doc 03 §4).
 *
 * One query shape serves both the on-screen list and the CSV export, so what an
 * admin exports is exactly what they were looking at.
 */

/**
 * Date filters are inclusive whole days in the operator's terms. `to` is
 * widened to the end of that day: an admin filtering "2 Sep to 2 Sep" means the
 * whole of the 2nd, not the single instant at midnight.
 *
 * The bound must be built in the same format as the column it is compared
 * against, because SQLite compares these as plain text. `reading_at` and
 * `activity_at` hold ISO; `created_at` is defaulted by `datetime('now')` and
 * holds SQLite's space-separated form. Handing an ISO bound to a SQLite-format
 * column loses a whole day: at index 10 the stored ' ' (0x20) sorts below the
 * bound's 'T' (0x54), so every row on the `from` date itself falls under the
 * lower bound and disappears — silently, with a 200 and an empty list.
 *
 * `format` is therefore required rather than defaulted. A default would let the
 * next column added here inherit the wrong one by omission, which is exactly
 * how this shipped.
 */
function dayBounds(from, to, format) {
  if (format !== 'iso' && format !== 'sqlite') {
    throw new TypeError(`dayBounds needs format 'iso' or 'sqlite', got: ${format}`);
  }
  const shape = (iso) => (format === 'iso' ? iso : isoToSqlite(iso));

  const clauses = [];
  const args = [];
  if (from) {
    clauses.push('>= ?');
    args.push(shape(`${from.slice(0, 10)}T00:00:00.000Z`));
  }
  if (to) {
    clauses.push('<= ?');
    args.push(shape(`${to.slice(0, 10)}T23:59:59.999Z`));
  }
  return { clauses, args };
}

/**
 * @param {string} timeColumn column the date filter compares against
 * @param {'iso'|'sqlite'} format the format that column actually stores
 * @param {string} prefix table alias, e.g. 'r.' when the query joins
 */
function filters(query, timeColumn, format, prefix = '') {
  const where = [];
  const args = [];

  if (query.shiftGroup) {
    where.push(`${prefix}shift_group = ?`);
    args.push(query.shiftGroup);
  }
  if (query.shiftTime) {
    where.push(`${prefix}shift_time = ?`);
    args.push(query.shiftTime);
  }

  const bounds = dayBounds(query.from, query.to, format);
  for (const [i, clause] of bounds.clauses.entries()) {
    where.push(`${timeColumn} ${clause}`);
    args.push(bounds.args[i]);
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

function readings(db, query) {
  // reading_at holds the operator's own ISO timestamp (validation.js normalises it).
  const { sql, args } = filters(query, 'r.reading_at', 'iso', 'r.');
  return db.prepare(`
    SELECT r.*, t.code AS tank_code
      FROM tank_readings r
      LEFT JOIN tanks t ON t.id = r.tank_id
      ${sql}
     ORDER BY r.reading_at DESC
     LIMIT ?
  `).all(...args, query.limit).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    tankId: r.tank_id,
    tankCode: r.tank_code ?? '',
    dcsLevelMm: r.dcs_level_mm,
    tapeLengthMm: r.tape_length_mm,
    bandulSulfurMm: r.bandul_sulfur_mm,
    levelMm: r.level_mm,
    deviationMm: r.deviation_mm,
    attempts: r.attempts,
    operatorName: r.operator_name,
    shiftGroup: r.shift_group,
    shiftTime: r.shift_time,
    photoPath: r.photo_path || '',
    note: r.note || '',
    readingAt: toIso(r.reading_at),
    receivedAt: toIso(r.received_at),
  }));
}

function activities(db, query) {
  // activity_at is likewise client ISO.
  const { sql, args } = filters(query, 'activity_at', 'iso');
  return db.prepare(`
    SELECT * FROM activity_logs ${sql} ORDER BY activity_at DESC LIMIT ?
  `).all(...args, query.limit).map((a) => ({
    id: a.id,
    clientId: a.client_id,
    type: a.type,
    description: a.description,
    contractorName: a.contractor_name || '',
    unitArea: a.unit_area || '',
    operatorName: a.operator_name,
    shiftGroup: a.shift_group,
    shiftTime: a.shift_time,
    activityAt: toIso(a.activity_at),
    receivedAt: toIso(a.received_at),
  }));
}

function cleaning(db, query) {
  // cleaning_sessions has no client-supplied "when it happened" column, so it
  // filters on created_at — which is SQLite-format, defaulted by datetime('now').
  const { sql, args } = filters(query, 'created_at', 'sqlite');
  return db.prepare(`
    SELECT * FROM cleaning_sessions ${sql} ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(...args, query.limit).map((c) => ({
    id: c.id,
    clientId: c.client_id,
    location: c.location,
    note: c.note || '',
    status: c.status,
    operatorName: c.operator_name,
    shiftGroup: c.shift_group,
    shiftTime: c.shift_time,
    beforePhoto: c.before_photo || '',
    afterPhoto: c.after_photo || '',
    beforePhotoAt: toIso(c.before_photo_at),
    afterPhotoAt: toIso(c.after_photo_at),
    receivedAt: toIso(c.received_at),
  }));
}

const FETCHERS = { readings, activities, cleaning };

export function fetchFieldData(db, query) {
  return FETCHERS[query.type](db, query);
}

/** Column sets for CSV export, in the order an admin expects to read them. */
export const CSV_COLUMNS = {
  readings: [
    { key: 'readingAt', header: 'Waktu Ukur (UTC)' },
    { key: 'tankCode', header: 'Tangki' },
    { key: 'dcsLevelMm', header: 'Level DCS (mm)' },
    { key: 'tapeLengthMm', header: 'Panjang Meteran (mm)' },
    { key: 'bandulSulfurMm', header: 'Sulfur Bandul (mm)' },
    { key: 'levelMm', header: 'Level Aktual (mm)' },
    { key: 'deviationMm', header: 'Deviasi (mm)' },
    { key: 'attempts', header: 'Percobaan' },
    { key: 'operatorName', header: 'Operator' },
    { key: 'shiftGroup', header: 'Shift' },
    { key: 'shiftTime', header: 'Waktu Shift' },
    { key: 'note', header: 'Catatan' },
    { key: 'receivedAt', header: 'Diterima Server (UTC)' },
  ],
  activities: [
    { key: 'activityAt', header: 'Waktu Aktivitas (UTC)' },
    { key: 'type', header: 'Tipe' },
    { key: 'description', header: 'Deskripsi' },
    { key: 'contractorName', header: 'Kontraktor' },
    { key: 'unitArea', header: 'Unit/Lokasi' },
    { key: 'operatorName', header: 'Operator' },
    { key: 'shiftGroup', header: 'Shift' },
    { key: 'shiftTime', header: 'Waktu Shift' },
    { key: 'receivedAt', header: 'Diterima Server (UTC)' },
  ],
  cleaning: [
    { key: 'receivedAt', header: 'Diterima Server (UTC)' },
    { key: 'location', header: 'Lokasi' },
    { key: 'status', header: 'Status' },
    { key: 'note', header: 'Catatan' },
    { key: 'operatorName', header: 'Operator' },
    { key: 'shiftGroup', header: 'Shift' },
    { key: 'shiftTime', header: 'Waktu Shift' },
    { key: 'beforePhoto', header: 'Foto Sebelum' },
    { key: 'afterPhoto', header: 'Foto Sesudah' },
  ],
};
