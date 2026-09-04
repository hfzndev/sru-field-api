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
