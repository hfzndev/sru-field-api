#!/usr/bin/env node
/**
 * Creates or resets the admin web account (doc 08 §3).
 *
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm run seed:admin
 *
 * Doubles as the password-reset path, so an admin locked out of the web UI is
 * recovered from the server rather than through a reset flow exposed to the
 * internet (doc 08 §4).
 */
import { hashPassword } from '../lib/auth.js';
import { openDatabase } from '../lib/db.js';

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    console.error('ADMIN_PASSWORD is required.\n  ADMIN_PASSWORD=... npm run seed:admin');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const db = openDatabase();
  const passwordHash = await hashPassword(password);

  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(passwordHash, existing.id);
    console.log(`admin '${username}' password reset`);
  } else {
    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    console.log(`admin '${username}' created`);
  }

  db.close();
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
