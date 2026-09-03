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
 * client_id is minted by our own app, so a malformed one is a client bug, not
 * operator error. Doc 10 §2.2 wants the whole request rejected with 400 rather
 * than a per-record error — the phone should be fixed, not tolerated.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const clientId = z.string().regex(UUID_V4, 'clientId harus UUID v4');

/**
 * Photo paths only ever come from POST /api/upload, which names files itself.
 * Constraining the shape here means a crafted path can never reach the database
 * and later be handed to the photo endpoint (doc 08 §7).
 * This is the contract /api/upload must produce.
 */
export const PHOTO_PATH = /^uploads\/(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/;
const photoPath = z.string().max(200).regex(PHOTO_PATH).or(z.literal('')).optional().default('');

/** Hours a client timestamp may sit in the future before we reject it (doc 08 §5). */
export const MAX_CLOCK_SKEW_HOURS = 24;

/**
 * A client-supplied timestamp. Stored as the same instant in canonical ISO:
 * the value is never adjusted, but normalising the format keeps `ORDER BY
 * reading_at` correct, since SQLite compares these as plain text and
 * "2026-09-02T.." sorts after "2026-09-02 ..".
 */
const clientTimestamp = z.string().min(1).max(40)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Waktu tidak dapat dibaca')
  .refine(
    (value) => new Date(value).getTime() <= Date.now() + MAX_CLOCK_SKEW_HOURS * 3600_000,
    `Waktu lebih dari ${MAX_CLOCK_SKEW_HOURS} jam di masa depan`,
  )
  .transform((value) => new Date(value).toISOString());

const optionalTimestamp = clientTimestamp.optional().nullable();

/** Attribution carried by every field record (doc 05 header). */
const attribution = {
  operatorName: z.string().min(1).max(CAPS.operatorName),
  shiftGroup: z.string().max(20).optional().default(''),
  shiftTime: z.enum(['pagi', 'sore', 'malam']).or(z.literal('')).optional().default(''),
};

export const readingSchema = z.object({
  clientId,
  tankId: z.number().int().positive(),
  dcsLevelMm: z.number().finite().nullable().optional().default(null),
  tapeLengthMm: z.number().finite(),
  bandulSulfurMm: z.number().finite(),
  attempts: z.number().int().min(1).max(99).optional().default(1),
  note: z.string().max(CAPS.note).optional().default(''),
  photoPath,
  readingAt: clientTimestamp,
  ...attribution,
});

export const cleaningSchema = z.object({
  clientId,
  location: z.string().min(1).max(CAPS.location),
  note: z.string().max(CAPS.note).optional().default(''),
  beforePhoto: photoPath,
  beforePhotoAt: optionalTimestamp,
  afterPhoto: photoPath,
  afterPhotoAt: optionalTimestamp,
  ...attribution,
});

export const activitySchema = z.object({
  clientId,
  type: z.enum(['OPERATOR', 'KONTRAKTOR']),
  description: z.string().min(1).max(CAPS.description),
  contractorName: z.string().max(CAPS.contractor).optional().default(''),
  unitArea: z.string().max(CAPS.location).optional().default(''),
  activityAt: clientTimestamp,
  ...attribution,
});

export const taskLogSchema = z.object({
  clientId,
  taskId: z.number().int().positive(),
  newStatus: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional().nullable(),
  progressPct: z.number().int().min(0).max(100).optional().nullable(),
  note: z.string().max(CAPS.note).optional().default(''),
  photoPath,
  logTime: optionalTimestamp,
  ...attribution,
  operatorName: z.string().max(CAPS.operatorName).optional().default(''),
});

export const syncSchema = z.object({
  readings: z.array(readingSchema).max(500).optional().default([]),
  cleaning: z.array(cleaningSchema).max(500).optional().default([]),
  activities: z.array(activitySchema).max(500).optional().default([]),
  taskLogs: z.array(taskLogSchema).max(500).optional().default([]),
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
