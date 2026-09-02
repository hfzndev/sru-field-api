/**
 * Midband tape measurement — the domain core (dok 02 §2, dok 04 §4).
 *
 * Operators drop a steel tape with a weighted bob ("bandul") through the tank
 * manhole. Where the tape stops tells them how much empty space is above the
 * sulfur; the sulfur stuck to the bob tells them how far it sank in. So:
 *
 *     level = height − tape_length + bandul_sulfur
 *
 * Every number here is recomputed server-side on sync and the result is written
 * to the database — the phone's own arithmetic is never trusted (dok 04 §3.2).
 * The recomputed values go back in the ack so the phone can reconcile.
 *
 * NOT here: the tape-length *suggestion* built from recent deviations. That is
 * deliberately client-side so it keeps working offline (dok 04 §4); the server
 * only ships the last 5 readings per tank at login.
 */

export const BANDUL_MIN_MM = 0;

/**
 * The bob's gauge physically cannot read past 99 mm. A reading above it does
 * not mean "lots of sulfur", it means the tape went in too deep and the
 * measurement is void — the operator is expected to retry shorter (dok 02 §2.1).
 */
export const BANDUL_MAX_MM = 99;

export const ERROR_CODES = {
  BANDUL_OUT_OF_RANGE: 'BANDUL_OUT_OF_RANGE',
  TAPE_TOO_LONG: 'TAPE_TOO_LONG',
  LEVEL_NEGATIVE: 'LEVEL_NEGATIVE',
};

/** Formats a millimetre value for an operator-facing message. */
function mm(value) {
  return `${Number(value)} mm`;
}

function assertFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // zod guarantees numeric types at the API boundary, so reaching this is a
    // bug in our own code, not bad operator input. Fail loudly rather than
    // producing a silently wrong level.
    throw new TypeError(`${name} must be a finite number, received ${JSON.stringify(value)}`);
  }
}

/**
 * Kills IEEE-754 representation noise (7953 − 2901.3 + 35 landing on
 * 5086.999999999999) without discarding real precision: 0.01 mm is two orders
 * of magnitude finer than anything a steel tape and a bob can resolve.
 */
function roundMm(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The formula itself. No validation — call validateReading first, or use
 * evaluateReading which does both.
 */
export function computeLevelMm({ heightMm, tapeLengthMm, bandulSulfurMm }) {
  assertFinite('heightMm', heightMm);
  assertFinite('tapeLengthMm', tapeLengthMm);
  assertFinite('bandulSulfurMm', bandulSulfurMm);
  return roundMm(heightMm - tapeLengthMm + bandulSulfurMm);
}

/**
 * How far the real level sits from what DCS claimed. Positive means the tank is
 * fuller than DCS reported.
 *
 * A null DCS reading yields a null deviation — the operator is allowed to skip
 * it when the screen is unreadable (dok 02 §2.3), and a missing input must not
 * silently become a deviation of zero, which would poison the phone's
 * suggestion average.
 */
export function computeDeviationMm(levelMm, dcsLevelMm) {
  if (dcsLevelMm === null || dcsLevelMm === undefined) return null;
  assertFinite('levelMm', levelMm);
  assertFinite('dcsLevelMm', dcsLevelMm);
  return roundMm(levelMm - dcsLevelMm);
}

/**
 * Domain validation (dok 04 §4). Returns null when the reading is acceptable,
 * otherwise `{ code, message }` where message is Indonesian and safe to show an
 * operator (dok 06 §1).
 *
 * Order is deliberate: bandul, then tape, then level.
 */
export function validateReading({ heightMm, tapeLengthMm, bandulSulfurMm }) {
  assertFinite('heightMm', heightMm);
  assertFinite('tapeLengthMm', tapeLengthMm);
  assertFinite('bandulSulfurMm', bandulSulfurMm);

  if (bandulSulfurMm < BANDUL_MIN_MM || bandulSulfurMm > BANDUL_MAX_MM) {
    return {
      code: ERROR_CODES.BANDUL_OUT_OF_RANGE,
      message: `Tinggi sulfur bandul ${BANDUL_MIN_MM}–${BANDUL_MAX_MM} mm (terbaca ${mm(bandulSulfurMm)})`,
    };
  }

  // Strictly less than: a tape equal to the tank height means it reached the
  // floor, so there is nothing to measure (dok 10 §2.1 pins this boundary).
  if (tapeLengthMm >= heightMm) {
    return {
      code: ERROR_CODES.TAPE_TOO_LONG,
      message: `Panjang meteran (${mm(tapeLengthMm)}) harus lebih pendek dari tinggi tangki (${mm(heightMm)})`,
    };
  }

  // Unreachable while the two checks above hold: tape < height gives
  // height − tape > 0, and bandul is non-negative, so the level is always
  // positive. Kept because dok 04 §4 specifies it and because it is the check
  // that would catch corrupt master data if the tape rule ever loosened.
  const levelMm = computeLevelMm({ heightMm, tapeLengthMm, bandulSulfurMm });
  if (levelMm < 0) {
    return {
      code: ERROR_CODES.LEVEL_NEGATIVE,
      message: `Level hasil hitung negatif (${mm(levelMm)}) — periksa panjang meteran dan tinggi tangki`,
    };
  }

  return null;
}

/**
 * Validate and compute in one step — what the sync engine calls per record.
 *
 * Never throws for bad operator input; a rejected reading comes back as
 * `{ ok: false, error }` so one bad record cannot fail the whole sync batch
 * (dok 06 §5).
 */
export function evaluateReading({ heightMm, tapeLengthMm, bandulSulfurMm, dcsLevelMm = null }) {
  const error = validateReading({ heightMm, tapeLengthMm, bandulSulfurMm });
  if (error) return { ok: false, error };

  const levelMm = computeLevelMm({ heightMm, tapeLengthMm, bandulSulfurMm });
  return {
    ok: true,
    levelMm,
    deviationMm: computeDeviationMm(levelMm, dcsLevelMm),
  };
}
