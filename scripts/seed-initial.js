#!/usr/bin/env node
/**
 * Seeds master data: the two tanks and the four shift accounts (doc 02 §1).
 *
 * Idempotent — safe to re-run against a live database. Existing rows keep their
 * data, only the password is refreshed when SHIFT_PASSWORD is supplied.
 *
 *   SHIFT_PASSWORD=... npm run seed:initial
 *
 * The password is read from the environment and never written to a file or
 * printed back (doc 08 §4).
 */
import { hashPassword } from '../lib/auth.js';
import { openDatabase } from '../lib/db.js';
import { stampMaster } from '../lib/dataversion.js';

/** Full codes only. "T-401" is forbidden everywhere (doc 02 §1.1). */
const TANKS = [
  { code: '93T-401', name: 'Tangki Sulfur 93T-401', heightMm: 7953 },
  { code: '93T-402', name: 'Tangki Sulfur 93T-402', heightMm: 7974 },
];

const SHIFTS = [
  { code: 'SHIFT_A', displayName: 'Shift A' },
  { code: 'SHIFT_B', displayName: 'Shift B' },
  { code: 'SHIFT_C', displayName: 'Shift C' },
  { code: 'SHIFT_D', displayName: 'Shift D' },
];

async function main() {
  const password = process.env.SHIFT_PASSWORD;
  if (!password) {
    console.error('SHIFT_PASSWORD is required.\n  SHIFT_PASSWORD=... npm run seed:initial');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('SHIFT_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const db = openDatabase();
  const passwordHash = await hashPassword(password);
  let created = 0;
  let updated = 0;

  // Every master row is stamped as it is written. Seeding without stamping
  // would leave data_version at 0, and rows created here would never appear in
  // an incremental pull (doc 05 §2).
  db.transaction(() => {
    for (const tank of TANKS) {
      const existing = db.prepare('SELECT id FROM tanks WHERE code = ?').get(tank.code);
      if (existing) {
        db.prepare('UPDATE tanks SET name = ?, height_mm = ?, is_active = 1 WHERE id = ?')
          .run(tank.name, tank.heightMm, existing.id);
        stampMaster(db, 'tanks', existing.id);
        updated += 1;
      } else {
        const info = db.prepare('INSERT INTO tanks (code, name, height_mm) VALUES (?, ?, ?)')
          .run(tank.code, tank.name, tank.heightMm);
        stampMaster(db, 'tanks', info.lastInsertRowid);
        created += 1;
      }
    }

    for (const shift of SHIFTS) {
      const existing = db.prepare('SELECT id FROM shift_accounts WHERE code = ?').get(shift.code);
      if (existing) {
        db.prepare('UPDATE shift_accounts SET display_name = ?, password_hash = ?, is_active = 1 WHERE id = ?')
          .run(shift.displayName, passwordHash, existing.id);
        stampMaster(db, 'shift_accounts', existing.id);
        updated += 1;
      } else {
        const info = db.prepare(
          'INSERT INTO shift_accounts (code, display_name, password_hash) VALUES (?, ?, ?)',
        ).run(shift.code, shift.displayName, passwordHash);
        stampMaster(db, 'shift_accounts', info.lastInsertRowid);
        created += 1;
      }
    }
  })();

  const version = db.prepare("SELECT value FROM meta WHERE key = 'dataVersion'").get().value;
  console.log(`seeded master: ${created} created, ${updated} updated (dataVersion now ${version})`);
  console.log(`tanks: ${TANKS.map((t) => t.code).join(', ')}`);
  console.log(`shift logins: ${SHIFTS.map((s) => s.code.toLowerCase()).join(', ')}`);
  db.close();
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
