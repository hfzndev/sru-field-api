import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, openDatabase } from '@/lib/db';

const opened = [];

function tempDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sru-field-')), 'field.db');
  const db = openDatabase(file);
  opened.push({ db, file });
  return db;
}

afterEach(() => {
  while (opened.length) {
    const { db, file } = opened.pop();
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

const TABLES = [
  'admin_users', 'tanks', 'equipment', 'equipment_status_log', 'contractors',
  'shift_accounts', 'shift_crew', 'maintenance_tasks', 'tank_readings',
  'cleaning_sessions', 'activity_logs', 'maintenance_task_logs',
  'device_tokens', 'meta', 'admin_actions',
];

const INDEXES = [
  'idx_readings_tank_time', 'idx_readings_shift', 'idx_activity_shift_time',
  'idx_cleaning_shift', 'idx_tasklog_task', 'idx_eq_status_log',
  'idx_devicetoken_account', 'idx_tanks_dataversion', 'idx_equipment_dataversion',
  'idx_contractors_dataversion', 'idx_shiftaccounts_dataversion',
  'idx_shiftcrew_dataversion', 'idx_tasks_dataversion',
];

// Every table the delta pull walks (dok 06 §5) must carry the integer stamp.
const MASTER_TABLES = [
  'tanks', 'equipment', 'contractors', 'shift_accounts', 'shift_crew', 'maintenance_tasks',
];

// Field-data tables are insert-only and are pulled by a 7-day received_at
// window, never by data_version — the stamp must not leak into them.
const FIELD_TABLES = [
  'tank_readings', 'cleaning_sessions', 'activity_logs', 'maintenance_task_logs',
];

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

describe('schema', () => {
  it('creates every table from doc 05', () => {
    const db = tempDb();
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of TABLES) expect(found, `missing table ${t}`).toContain(t);
  });

  it('creates every index from doc 05', () => {
    const db = tempDb();
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    for (const i of INDEXES) expect(found, `missing index ${i}`).toContain(i);
  });

  it('runs in WAL mode', () => {
    expect(tempDb().pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('seeds dataVersion at 0', () => {
    const row = tempDb().prepare("SELECT value FROM meta WHERE key='dataVersion'").get();
    expect(row.value).toBe('0');
  });
});

describe('data_version stamp column', () => {
  it('exists on every master table, alongside updated_at', () => {
    const db = tempDb();
    for (const t of MASTER_TABLES) {
      const cols = columns(db, t);
      expect(cols, `${t}.data_version`).toContain('data_version');
      expect(cols, `${t}.updated_at`).toContain('updated_at');
    }
  });

  it('is absent from field-data tables', () => {
    const db = tempDb();
    for (const t of FIELD_TABLES) {
      expect(columns(db, t), `${t} should not carry data_version`).not.toContain('data_version');
    }
  });

  it('defaults to 0 so a fresh row is always older than any since= cursor', () => {
    const db = tempDb();
    db.prepare("INSERT INTO contractors (name) VALUES ('PT Tejo Lomanis')").run();
    const row = db.prepare('SELECT data_version FROM contractors').get();
    expect(row.data_version).toBe(0);
  });
});

describe('migrate', () => {
  it('is idempotent', () => {
    const db = tempDb();
    db.prepare("INSERT INTO contractors (name) VALUES ('PT Tejo Lomanis')").run();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM contractors').get().n).toBe(1);
    expect(db.prepare("SELECT value FROM meta WHERE key='dataVersion'").get().value).toBe('0');
  });

  it('adds v1.1 columns to a pre-existing v1.0 table without losing rows', () => {
    // Stand up the old shape by hand, then let migrate() bring it forward.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-field-old-'));
    const file = path.join(dir, 'field.db');
    const raw = new Database(file);
    raw.exec(`CREATE TABLE contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    raw.prepare("INSERT INTO contractors (name) VALUES ('PT Lama')").run();
    raw.close();

    const db = openDatabase(file);
    opened.push({ db, file });

    const cols = columns(db, 'contractors');
    expect(cols).toContain('data_version');
    expect(cols).toContain('updated_at');

    const row = db.prepare("SELECT * FROM contractors WHERE name='PT Lama'").get();
    expect(row.data_version).toBe(0);
    expect(row.updated_at, 'backfilled, not left null').toBeTruthy();
  });
});
