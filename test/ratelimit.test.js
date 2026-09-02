import { beforeEach, describe, expect, it } from 'vitest';
import {
  LIMITS,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  checkLoginLockout,
  clearLoginFailures,
  limitFor,
  rateLimit,
  recordLoginFailure,
  resetRateLimits,
} from '@/lib/ratelimit';

beforeEach(resetRateLimits);

describe('rateLimit', () => {
  const config = { limit: 3, windowMs: 60_000 };

  it('allows up to the limit then blocks', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimit('k', config).allowed, `call ${i + 1}`).toBe(true);
    }
    const blocked = rateLimit('k', config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('counts each key separately', () => {
    for (let i = 0; i < 3; i += 1) rateLimit('a', config);
    expect(rateLimit('a', config).allowed).toBe(false);
    expect(rateLimit('b', config).allowed).toBe(true);
  });

  it('reopens after the window passes', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) rateLimit('k', config, now);
    expect(rateLimit('k', config, now).allowed).toBe(false);
    expect(rateLimit('k', config, now + 60_001).allowed).toBe(true);
  });

  it('reports remaining allowance', () => {
    expect(rateLimit('k', config).remaining).toBe(2);
    expect(rateLimit('k', config).remaining).toBe(1);
  });
});

describe('configured limits (doc 08 §6)', () => {
  it('matches the spec', () => {
    expect(LIMITS.login).toEqual({ limit: 10, windowMs: 60_000 });
    expect(LIMITS.adminLogin).toEqual({ limit: 5, windowMs: 600_000 });
    expect(LIMITS.sync).toEqual({ limit: 30, windowMs: 60_000 });
    expect(LIMITS.upload).toEqual({ limit: 20, windowMs: 3_600_000 });
    expect(LIMITS.general).toEqual({ limit: 120, windowMs: 60_000 });
  });

  it('namespaces keys per route family', () => {
    // The same IP hitting login and sync must not share one bucket.
    for (let i = 0; i < 10; i += 1) limitFor('login', '1.2.3.4');
    expect(limitFor('login', '1.2.3.4').allowed).toBe(false);
    expect(limitFor('sync', '1.2.3.4').allowed).toBe(true);
  });

  it('throws on an unknown limit name rather than silently not limiting', () => {
    expect(() => limitFor('nope', 'x')).toThrow(/unknown rate limit/);
  });
});

describe('login lockout (doc 06 §4)', () => {
  it('locks after five failures', () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      expect(checkLoginLockout('shift_a').locked, `before failure ${i + 1}`).toBe(false);
      recordLoginFailure('shift_a');
    }
    expect(checkLoginLockout('shift_a').locked).toBe(true);
  });

  it('locks each username independently', () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) recordLoginFailure('shift_a');
    expect(checkLoginLockout('shift_a').locked).toBe(true);
    expect(checkLoginLockout('shift_b').locked).toBe(false);
  });

  it('clears on a successful login', () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) recordLoginFailure('shift_a');
    clearLoginFailures('shift_a');
    expect(checkLoginLockout('shift_a').locked).toBe(false);
  });

  it('releases after the window without needing a restart', () => {
    const now = Date.now();
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) recordLoginFailure('shift_a', now);
    expect(checkLoginLockout('shift_a', now).locked).toBe(true);
    expect(checkLoginLockout('shift_a', now + LOGIN_FAILURE_WINDOW_MS + 1).locked).toBe(false);
  });

  it('anchors the window on the first failure, so it cannot be extended indefinitely', () => {
    // An operator who keeps mistyping should be locked out for ten minutes,
    // not ten minutes from whenever they last gave up.
    const now = Date.now();
    recordLoginFailure('shift_a', now);
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i += 1) {
      recordLoginFailure('shift_a', now + i * 60_000);
    }
    expect(checkLoginLockout('shift_a', now + LOGIN_FAILURE_WINDOW_MS + 1).locked).toBe(false);
  });
});
