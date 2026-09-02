/**
 * In-memory rate limiting and brute-force guard (doc 08 §6).
 *
 * In-memory is sufficient and intentional: one container, one process, four
 * devices (doc 04 §5). Redis would be infrastructure to operate for no gain.
 * The tradeoff is that counters reset on restart — acceptable for throttling,
 * which is why login lockout is a speed bump, not an authorisation control.
 */

/** Limits from doc 08 §6, keyed by route family. */
export const LIMITS = {
  login: { limit: 10, windowMs: 60_000 },
  adminLogin: { limit: 5, windowMs: 10 * 60_000 },
  sync: { limit: 30, windowMs: 60_000 },
  upload: { limit: 20, windowMs: 60 * 60_000 },
  general: { limit: 120, windowMs: 60_000 },
};

/** Brute-force guard from doc 06 §4: 5 failures per username per 10 minutes. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000;

const buckets = new Map();   // key -> { count, resetAt }
const failures = new Map();  // username -> { count, resetAt }

function sweep(map, now) {
  // Small maps (a handful of devices), so a full pass is cheaper than tracking
  // expiries separately. Keeps memory flat over a long-running container.
  for (const [key, entry] of map) {
    if (entry.resetAt <= now) map.delete(key);
  }
}

/**
 * Fixed-window counter.
 * @returns {{allowed: boolean, remaining: number, retryAfterSec: number}}
 */
export function rateLimit(key, { limit, windowMs }, now = Date.now()) {
  sweep(buckets, now);

  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSec: (entry.resetAt - now) / 1000 };
  }
  return { allowed: true, remaining: limit - entry.count, retryAfterSec: 0 };
}

/** Convenience wrapper: `limitFor('login', ip)`. */
export function limitFor(name, key, now = Date.now()) {
  const config = LIMITS[name];
  if (!config) throw new Error(`unknown rate limit: ${name}`);
  return rateLimit(`${name}:${key}`, config, now);
}

/**
 * Checked *before* verifying a password, so a locked-out username costs no
 * bcrypt work and the attacker learns nothing from response timing.
 */
export function checkLoginLockout(username, now = Date.now()) {
  sweep(failures, now);
  const entry = failures.get(username);
  if (!entry || entry.resetAt <= now) return { locked: false, retryAfterSec: 0 };
  if (entry.count >= LOGIN_FAILURE_LIMIT) {
    return { locked: true, retryAfterSec: (entry.resetAt - now) / 1000 };
  }
  return { locked: false, retryAfterSec: 0 };
}

/**
 * Records one failed attempt. The window is anchored on the first failure and
 * does not extend on subsequent ones, so a legitimate operator who fat-fingers
 * their password is never locked out for longer than 10 minutes.
 */
export function recordLoginFailure(username, now = Date.now()) {
  const entry = failures.get(username);
  if (!entry || entry.resetAt <= now) {
    failures.set(username, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Clears the counter after a successful login. */
export function clearLoginFailures(username) {
  failures.delete(username);
}

/** Test seam — production code never calls this. */
export function resetRateLimits() {
  buckets.clear();
  failures.clear();
}
