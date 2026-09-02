import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearedSessionCookieOptions,
  createSession,
  readSession,
  sessionCookieOptions,
} from '@/lib/session';

const SECRET = 'a'.repeat(64);
const originalSecret = process.env.SESSION_SECRET;
const originalEnv = process.env.NODE_ENV;

beforeEach(() => { process.env.SESSION_SECRET = SECRET; });
afterEach(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  process.env.NODE_ENV = originalEnv;
});

describe('createSession / readSession', () => {
  it('round-trips a username', () => {
    const session = readSession(createSession('admin'));
    expect(session.username).toBe('admin');
  });

  it('expires after 8 hours (doc 08 §3)', () => {
    const now = Date.now();
    const cookie = createSession('admin', now);

    expect(readSession(cookie, now + (SESSION_TTL_SECONDS - 60) * 1000)).not.toBeNull();
    expect(readSession(cookie, now + (SESSION_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    // The whole point of signing: an admin cannot edit the cookie to become
    // another user, because the HMAC no longer matches.
    const [, signature] = createSession('admin').split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'root', exp: 9_999_999_999 })).toString('base64url');
    expect(readSession(`${forged}.${signature}`)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const [payload] = createSession('admin').split('.');
    expect(readSession(`${payload}.${Buffer.from('nope').toString('base64url')}`)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = createSession('admin');
    process.env.SESSION_SECRET = 'b'.repeat(64);
    expect(readSession(cookie)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const value of ['', 'nodot', 'a.b.c.d', null, undefined, 42, {}]) {
      expect(readSession(value)).toBeNull();
    }
  });
});

describe('secret requirements', () => {
  it('refuses to sign without a secret', () => {
    delete process.env.SESSION_SECRET;
    expect(() => createSession('admin')).toThrow(/SESSION_SECRET/);
  });

  it('refuses a secret shorter than 32 bytes', () => {
    process.env.SESSION_SECRET = 'too-short';
    expect(() => createSession('admin')).toThrow(/32 bytes/);
  });

  it('fails closed when verifying without a secret', () => {
    // A missing secret must never make verification succeed.
    process.env.SESSION_SECRET = SECRET;
    const cookie = createSession('admin');
    delete process.env.SESSION_SECRET;
    expect(readSession(cookie)).toBeNull();
  });
});

describe('cookie attributes', () => {
  it('is httpOnly and lax by default', () => {
    const options = sessionCookieOptions();
    expect(options.name).toBe(SESSION_COOKIE);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('sets Secure in production only', () => {
    process.env.NODE_ENV = 'production';
    expect(sessionCookieOptions().secure).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it('clears with maxAge 0 on logout', () => {
    expect(clearedSessionCookieOptions().maxAge).toBe(0);
  });
});
