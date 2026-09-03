/**
 * The delta-pull counter (doc 07 §7, doc 05 §2).
 *
 * `meta.dataVersion` increments on every master mutation, and the new value is
 * stamped onto the changed row's `data_version` column. Pull then filters
 * `data_version > since` — integer against integer.
 *
 * Both writes must happen inside one transaction. If the bump and the stamp can
 * be observed apart, a device that pulls in between records a cursor higher
 * than a row it never received, and that row becomes invisible forever.
 */

/**
 * Tables carrying the stamp. This is an allowlist, not documentation: table
 * names are interpolated into SQL below, and every caller passes a literal, so
 * the list is what keeps that safe.
 */
const STAMPABLE = new Set([
  'tanks',
  'equipment',
  'contractors',
  'shift_accounts',
  'shift_crew',
  'maintenance_tasks',
]);

export function currentDataVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'dataVersion'").get();
  return Number(row?.value ?? 0);
}

/**
 * Increments the counter and returns the new value.
 * Call inside a transaction, alongside the stamp.
 */
export function bumpDataVersion(db) {
  const next = currentDataVersion(db) + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'dataVersion'").run(String(next));
  return next;
}

/**
 * Bumps the counter and stamps one master row, refreshing `updated_at` for
 * display. Returns the new version.
 *
 * @param {string} table one of STAMPABLE
 */
export function stampMaster(db, table, id) {
  if (!STAMPABLE.has(table)) {
    throw new Error(`refusing to stamp unknown table: ${table}`);
  }
  const version = bumpDataVersion(db);
  db.prepare(
    `UPDATE ${table} SET data_version = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(version, id);
  return version;
}

export const STAMPABLE_TABLES = STAMPABLE;
