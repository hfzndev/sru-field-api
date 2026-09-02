import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateDevice,
  bearerToken,
  hashPassword,
  hashToken,
  mintToken,
  usernameToShiftCode,
  verifyPassword,
  verifyPasswordConstantTime,
} from '@/lib/auth';
import { cleanupTempDbs, seedShiftAccount, useTempDb, withBearer } from './helpers/seed.js';

let db;
beforeEach(() => { db = useTempDb(); });
afterAll(cleanupTempDbs);

function request(headers = {}) {
  return new Request('http://localhost/api/sync', { method: 'POST', headers });
}

function issueToken(db, shiftAccountId, deviceName = 'HP-1') {
  const { token, tokenHash } = mintToken();
  db.prepare(`
    INSERT INTO device_tokens (shift_account_id, token_hash, device_name, app_version)
    VALUES (?, ?, ?, '1.0.0')
  `).run(shiftAccountId, tokenHash, deviceName);
  return token;
}

describe('token minting', () => {
  it('produces 32 random bytes as 64 hex characters', () => {
    const { token } = mintToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintToken().token));
    expect(tokens.size).toBe(50);
  });

  it('hashes deterministically with sha256', () => {
    const { token, tokenHash } = mintToken();
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('rahasia123');
    expect(hash.startsWith('$2')).toBe(true); // bcrypt, not plaintext
    expect(await verifyPassword('rahasia123', hash)).toBe(true);
    expect(await verifyPassword('salah', hash)).toBe(false);
  });

  it('still performs a comparison when the account does not exist', async () => {
    // Guards the username-enumeration timing leak: a missing account must not
    // return faster than a wrong password.
    expect(await verifyPasswordConstantTime('apapun', undefined)).toBe(false);
    expect(await verifyPasswordConstantTime('apapun', null)).toBe(false);
  });
});

describe('usernameToShiftCode', () => {
  it('maps the login name to the storage code (doc 02 §1.3)', () => {
    expect(usernameToShiftCode('shift_a')).toBe('SHIFT_A');
    expect(usernameToShiftCode('  shift_d  ')).toBe('SHIFT_D');
  });

  it('tolerates empty input without throwing', () => {
    expect(usernameToShiftCode(undefined)).toBe('');
  });
});

describe('bearerToken', () => {
  it('reads a well-formed header, case-insensitively', () => {
    expect(bearerToken(request({ authorization: 'Bearer abc123' }))).toBe('abc123');
    expect(bearerToken(request({ authorization: 'bearer abc123' }))).toBe('abc123');
  });

  it('returns null for anything else', () => {
    expect(bearerToken(request())).toBeNull();
    expect(bearerToken(request({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerToken(request({ authorization: 'Bearer' }))).toBeNull();
  });
});

describe('authenticateDevice', () => {
  it('resolves a live token to its shift account', () => {
    const accountId = seedShiftAccount(db);
    const token = issueToken(db, accountId);

    const auth = authenticateDevice(request(withBearer(token)), db);
    expect(auth.ok).toBe(true);
    expect(auth.account.code).toBe('SHIFT_A');
    expect(auth.token.deviceName).toBe('HP-1');
  });

  it('stores only the hash — the raw token never reaches the database', () => {
    const accountId = seedShiftAccount(db);
    const token = issueToken(db, accountId);

    const rows = db.prepare('SELECT token_hash FROM device_tokens').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);

    // Belt and braces: the raw value must appear nowhere in the table at all.
    const dump = JSON.stringify(db.prepare('SELECT * FROM device_tokens').all());
    expect(dump).not.toContain(token);
  });

  it('rejects an unknown token', () => {
    seedShiftAccount(db);
    const auth = authenticateDevice(request(withBearer('deadbeef')), db);
    expect(auth.ok).toBe(false);
    expect(auth.reason).toBe('UNKNOWN_TOKEN');
  });

  it('rejects a revoked token', () => {
    const accountId = seedShiftAccount(db);
    const token = issueToken(db, accountId);
    db.prepare("UPDATE device_tokens SET revoked_at = datetime('now')").run();

    const auth = authenticateDevice(request(withBearer(token)), db);
    expect(auth.ok).toBe(false);
    expect(auth.reason).toBe('REVOKED');
  });

  it('rejects a token whose account was deactivated', () => {
    const accountId = seedShiftAccount(db, { isActive: 0 });
    const token = issueToken(db, accountId);

    const auth = authenticateDevice(request(withBearer(token)), db);
    expect(auth.ok).toBe(false);
    expect(auth.reason).toBe('ACCOUNT_INACTIVE');
  });

  it('rejects a missing header', () => {
    const auth = authenticateDevice(request(), db);
    expect(auth.ok).toBe(false);
    expect(auth.reason).toBe('MISSING_TOKEN');
  });

  it('records last_seen_at for the admin Devices tab', () => {
    const accountId = seedShiftAccount(db);
    const token = issueToken(db, accountId);
    db.prepare('UPDATE device_tokens SET last_seen_at = NULL').run();

    authenticateDevice(request(withBearer(token)), db);
    expect(db.prepare('SELECT last_seen_at FROM device_tokens').get().last_seen_at).toBeTruthy();
  });
});
