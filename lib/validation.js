import { z } from 'zod';

/**
 * Schemas for every request boundary (doc 08 §5).
 *
 * Plain z.object() strips unknown keys rather than rejecting them, which is the
 * whitelist behaviour the spec asks for: a phone on an older build can send a
 * field we no longer read without its whole sync failing.
 */

/** Text length caps from doc 08 §5. */
export const CAPS = {
  description: 500,
  note: 500,
  location: 200,
  contractor: 150,
  operatorName: 100,
  deviceName: 100,
  appVersion: 50,
  username: 100,
  password: 200,
};

export const loginSchema = z.object({
  // Intentionally permissive: an unknown username must fail as a generic 401
  // from the lookup, not as a 400 here. A stricter pattern would let an
  // attacker separate "malformed" from "wrong", which is half an answer.
  username: z.string().min(1).max(CAPS.username),
  password: z.string().min(1).max(CAPS.password),
  deviceName: z.string().max(CAPS.deviceName).optional().default(''),
  appVersion: z.string().max(CAPS.appVersion).optional().default(''),
});

export const adminLoginSchema = z.object({
  username: z.string().min(1).max(CAPS.username),
  password: z.string().min(1).max(CAPS.password),
});

/**
 * Flattens zod issues into the `details` array of the error envelope
 * (doc 06 §1). Field paths are included; submitted values never are, so a
 * password can't end up echoed into a log or an error response.
 */
export function issueDetails(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * @returns {{ok: true, data}} or {{ok: false, details}}
 */
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, details: issueDetails(result.error) };
}
