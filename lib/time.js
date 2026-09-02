/**
 * Timestamp handling.
 *
 * The database stores UTC via SQLite's datetime('now'), which formats as
 * "2026-09-02 17:53:46" — UTC, but NOT ISO-8601: no T separator, no Z suffix.
 * Doc 06 §1 requires ISO-8601 UTC on the wire, so every stored timestamp is
 * converted on the way out. Handing the phone the raw SQLite form would give it
 * a string that `new Date(...)` parses inconsistently across engines, and on
 * some it is read as local time — silently shifting every field record by the
 * WIB offset.
 */

const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Stored timestamp → ISO-8601 UTC.
 *
 * Accepts both shapes we can encounter: SQLite's datetime('now') output, and
 * client-supplied values already stored as ISO (reading_at, activity_at).
 * Returns null for empty input. An unparseable non-empty value is returned
 * unchanged rather than dropped — losing an operator's timestamp is worse than
 * emitting an odd one, and it makes the bad data visible instead of silent.
 */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;

  if (SQLITE_UTC.test(value)) return `${value.replace(' ', 'T')}.000Z`;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString();
}

/** Current time as ISO-8601 UTC — for `serverTime` fields in API responses. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * ISO-8601 → SQLite's UTC storage format, for values compared against columns
 * defaulted with datetime('now') (the 7-day pull window, retention sweeps).
 * Mixing the two formats in a comparison silently returns wrong rows: SQLite
 * compares them as plain strings, and "2026-09-02T17:53:46.000Z" sorts after
 * "2026-09-02 17:53:46" on the space-vs-T byte alone.
 */
export function isoToSqlite(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`invalid ISO timestamp: ${iso}`);
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

/** SQLite-format UTC timestamp for `n` days ago — the pull/retention window. */
export function sqliteDaysAgo(days, from = new Date()) {
  return isoToSqlite(new Date(from.getTime() - days * 86400000).toISOString());
}
