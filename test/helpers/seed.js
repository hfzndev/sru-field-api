import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from '@/lib/db';
import { resetLastSeenThrottle } from '@/lib/auth';
import { resetRateLimits } from '@/lib/ratelimit';
import { stampSheet } from '@/lib/sheets';

/**
 * Test fixtures.
 *
 * Route handlers reach the database through the getDb() singleton, so tests
 * point DATABASE_PATH at a scratch file and drop the cached handle. Each test
 * gets a genuinely empty database rather than a rolled-back shared one.
 */

const dirs = [];

/** bcrypt at cost 10 is ~100ms; hashing once per run keeps the suite quick. */
export const TEST_PASSWORD = 'rahasia123';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

export function useTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-field-test-'));
  dirs.push(dir);
  process.env.DATABASE_PATH = path.join(dir, 'field.db');
  closeDb();
  resetRateLimits();
  resetLastSeenThrottle();
  return getDb();
}

export function cleanupTempDbs() {
  closeDb();
  while (dirs.length) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
  delete process.env.DATABASE_PATH;
}

export function seedAdmin(db, username = 'admin') {
  return db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
    .run(username, TEST_PASSWORD_HASH).lastInsertRowid;
}

export function seedShiftAccount(db, { code = 'SHIFT_A', displayName = 'Shift A', isActive = 1 } = {}) {
  const info = db.prepare(`
    INSERT INTO shift_accounts (code, display_name, password_hash, is_active)
    VALUES (?, ?, ?, ?)
  `).run(code, displayName, TEST_PASSWORD_HASH, isActive);
  return info.lastInsertRowid;
}

export function seedCrew(db, shiftAccountId, names) {
  const stmt = db.prepare('INSERT INTO shift_crew (shift_account_id, name, sort_order) VALUES (?, ?, ?)');
  names.forEach((name, i) => stmt.run(shiftAccountId, name, i));
}

/** The only two real tanks (doc 02 §1.1). */
export function seedTanks(db) {
  const stmt = db.prepare('INSERT INTO tanks (code, name, height_mm) VALUES (?, ?, ?)');
  return {
    t401: stmt.run('93T-401', 'Tangki Sulfur 93T-401', 7953).lastInsertRowid,
    t402: stmt.run('93T-402', 'Tangki Sulfur 93T-402', 7974).lastInsertRowid,
  };
}

export function seedEquipment(db, { tagNumber = 'P-9101', name = 'Kompresor', status = 'NORMAL', isActive = 1 } = {}) {
  return db.prepare('INSERT INTO equipment (tag_number, name, status, is_active) VALUES (?, ?, ?, ?)')
    .run(tagNumber, name, status, isActive).lastInsertRowid;
}

export function seedContractor(db, name = 'PT Tejo Lomanis', isActive = 1) {
  return db.prepare('INSERT INTO contractors (name, is_active) VALUES (?, ?)')
    .run(name, isActive).lastInsertRowid;
}

export function seedTask(db, equipmentId, { title = 'Ganti bearing', status = 'OPEN', progressPct = 0 } = {}) {
  return db.prepare(`
    INSERT INTO maintenance_tasks (equipment_id, title, status, progress_pct) VALUES (?, ?, ?, ?)
  `).run(equipmentId, title, status, progressPct).lastInsertRowid;
}

export function seedReading(db, tankId, { clientId, levelMm, dcsLevelMm, readingAt, tapeLengthMm = 2901, bandulSulfurMm = 35 }) {
  return db.prepare(`
    INSERT INTO tank_readings
      (client_id, tank_id, dcs_level_mm, tape_length_mm, bandul_sulfur_mm, level_mm, deviation_mm,
       operator_name, shift_group, shift_time, reading_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Budi', 'Shift A', 'pagi', ?)
  `).run(
    clientId, tankId, dcsLevelMm, tapeLengthMm, bandulSulfurMm, levelMm,
    dcsLevelMm === null ? null : levelMm - dcsLevelMm, readingAt,
  ).lastInsertRowid;
}

/** Builds a POST Request for calling a route handler directly (doc 10 §1). */
export function postRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function withBearer(token) {
  return { authorization: `Bearer ${token}` };
}

/**
 * A lembar tugas, built the way the admin builder builds one: a sheet plus its
 * columns and rows in one go. Returns the ids the tests need to address cells.
 */
export function seedSheet(db, {
  title = 'Foto Pompa Area 93',
  status = 'OPEN',
  assignedShift = '',
  allowOperatorRows = 1,
  isActive = 1,
  columns = [
    { label: 'Foto Wide', kind: 'PHOTO', isRequired: 1 },
    { label: 'Foto Close', kind: 'PHOTO', isRequired: 1 },
  ],
  rows = ['93P-101A', '93P-101B'],
} = {}) {
  const sheetId = Number(db.prepare(`
    INSERT INTO task_sheets (title, status, assigned_shift, allow_operator_rows, is_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, status, assignedShift, allowOperatorRows, isActive).lastInsertRowid);

  const columnStmt = db.prepare(`
    INSERT INTO task_sheet_columns (sheet_id, label, kind, is_required, options, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const columnIds = columns.map((c, i) => Number(columnStmt.run(
    sheetId, c.label, c.kind, c.isRequired ?? 1, JSON.stringify(c.options ?? []), i,
  ).lastInsertRowid));

  const rowStmt = db.prepare(
    'INSERT INTO task_sheet_rows (sheet_id, label, sort_order, added_by_name) VALUES (?, ?, ?, ?)',
  );
  const rowIds = rows.map((label, i) => Number(rowStmt.run(sheetId, label, i, 'admin').lastInsertRowid));

  // Stamped exactly as the admin create route stamps it, so a test that reads
  // a delta sees the same cursor a real handset would.
  stampSheet(db, sheetId);

  return { sheetId, columnIds, rowIds };
}

/** A photo path shaped the way /api/upload produces them (lib/validation PHOTO_PATH). */
export function samplePhotoPath(seed = 'a') {
  return `uploads/${seed.repeat(32).slice(0, 32)}.jpg`;
}
