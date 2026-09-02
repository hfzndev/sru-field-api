import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_INDEXES, SCHEMA_TABLES } from './schema.generated.js';

/**
 * Where field.db lives. Container mounts ./data:/app/data (dok 09 §1), so the
 * default is relative to the working directory, overridable for tests.
 */
export function dbPath() {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  return path.resolve(process.cwd(), 'data', 'field.db');
}

/**
 * Columns introduced after the first deployed schema (docs v1.1).
 *
 * Migrations are additive-only so rolling an image back never needs a reverse
 * migration (dok 09 §7). SQLite refuses a non-constant DEFAULT in ALTER TABLE
 * ADD COLUMN, so timestamp columns are added bare and backfilled below.
 */
const ADDITIVE_COLUMNS = [
  ['tanks', 'data_version', 'INTEGER NOT NULL DEFAULT 0', null],
  ['equipment', 'data_version', 'INTEGER NOT NULL DEFAULT 0', null],
  ['contractors', 'data_version', 'INTEGER NOT NULL DEFAULT 0', null],
  ['contractors', 'updated_at', 'TEXT', "datetime('now')"],
  ['shift_accounts', 'data_version', 'INTEGER NOT NULL DEFAULT 0', null],
  ['shift_crew', 'data_version', 'INTEGER NOT NULL DEFAULT 0', null],
  ['shift_crew', 'created_at', 'TEXT', "datetime('now')"],
  ['shift_crew', 'updated_at', 'TEXT', "datetime('now')"],
  ['maintenance_tasks', 'data_version', 'INTEGER NOT NULL DEFAULT 0', null],
];

/**
 * Tables and indexes run as separate steps, and the order matters.
 *
 * An index like idx_contractors_dataversion references a column that
 * ADDITIVE_COLUMNS may still be about to add: on a database created before that
 * column existed, CREATE TABLE IF NOT EXISTS is a no-op, so executing tables and
 * indexes in one shot hits "no such column: data_version" and the upgrade dies.
 * Order must be: tables → additive columns → indexes.
 *
 * The SQL is imported rather than read from disk — an fs read here makes Next
 * trace the whole project into the standalone output.
 */

function applyAdditiveColumns(db) {
  for (const [table, column, definition, backfill] of ADDITIVE_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all()
      .some((c) => c.name === column);
    if (exists) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (backfill) {
      db.exec(`UPDATE ${table} SET ${column} = ${backfill} WHERE ${column} IS NULL`);
    }
  }
}

/**
 * Creates/upgrades the schema and guarantees the invariants the sync protocol
 * assumes. Safe to call repeatedly — every statement is IF NOT EXISTS.
 */
export function migrate(db) {
  db.exec(SCHEMA_TABLES);
  applyAdditiveColumns(db); // must precede indexes that reference the new columns
  db.exec(SCHEMA_INDEXES);
  // dataVersion is the delta-pull counter (dok 07 §7). Absent = never synced.
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('dataVersion', '0')").run();
  return db;
}

export function openDatabase(file = dbPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');   // survives concurrent reads during sync
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return migrate(db);
}

/**
 * Process-wide singleton. Stashed on globalThis so Next's dev hot-reload does
 * not open a new handle on every edit and exhaust file descriptors.
 */
const GLOBAL_KEY = Symbol.for('sru-field-api.db');

export function getDb() {
  if (!globalThis[GLOBAL_KEY]) globalThis[GLOBAL_KEY] = openDatabase();
  return globalThis[GLOBAL_KEY];
}

export function closeDb() {
  const db = globalThis[GLOBAL_KEY];
  if (db) {
    db.close();
    delete globalThis[GLOBAL_KEY];
  }
}
