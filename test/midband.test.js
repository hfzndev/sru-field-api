import { describe, expect, it } from 'vitest';
import {
  BANDUL_MAX_MM,
  ERROR_CODES,
  computeDeviationMm,
  computeLevelMm,
  evaluateReading,
  validateReading,
} from '@/lib/midband';

// The only two tanks that exist (dok 02 §1.1). Codes are never abbreviated.
const T401 = 7953; // 93T-401
const T402 = 7974; // 93T-402

describe('worked example from doc 02 §2.1', () => {
  it('7953 − 2901 + 35 = 5087, deviation +87 against DCS 5000', () => {
    const result = evaluateReading({
      heightMm: T401,
      tapeLengthMm: 2901,
      bandulSulfurMm: 35,
      dcsLevelMm: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.levelMm).toBe(5087);
    expect(result.deviationMm).toBe(87);
  });
});

describe('computeLevelMm', () => {
  it('reduces to height − tape when the bob comes back bare', () => {
    expect(computeLevelMm({ heightMm: T401, tapeLengthMm: 2901, bandulSulfurMm: 0 })).toBe(5052);
  });

  it('works for 93T-402 as well as 93T-401', () => {
    expect(computeLevelMm({ heightMm: T402, tapeLengthMm: 2901, bandulSulfurMm: 35 })).toBe(5108);
  });

  it('absorbs floating-point noise from decimal tape readings', () => {
    // Raw IEEE arithmetic here yields 5053.099999999999 — verified to be a case
    // that genuinely needs rounding, so this fails if roundMm is removed.
    expect(T401 - 2900.1 + 0.2).not.toBe(5053.1); // guards the guard
    const level = computeLevelMm({ heightMm: T401, tapeLengthMm: 2900.1, bandulSulfurMm: 0.2 });
    expect(level).toBe(5053.1);
  });

  it('throws on non-finite input rather than producing a wrong level', () => {
    expect(() => computeLevelMm({ heightMm: T401, tapeLengthMm: NaN, bandulSulfurMm: 35 })).toThrow(TypeError);
    expect(() => computeLevelMm({ heightMm: T401, tapeLengthMm: '2901', bandulSulfurMm: 35 })).toThrow(TypeError);
    expect(() => computeLevelMm({ heightMm: T401, tapeLengthMm: 2901, bandulSulfurMm: undefined })).toThrow(TypeError);
  });
});

describe('computeDeviationMm', () => {
  it('is positive when the tank is fuller than DCS claimed', () => {
    expect(computeDeviationMm(5087, 5000)).toBe(87);
  });

  it('is negative when DCS overstates the level', () => {
    expect(computeDeviationMm(4950, 5000)).toBe(-50);
  });

  it('absorbs floating-point noise from a decimal DCS reading', () => {
    // 5087 − 5000.1 evaluates to 86.89999999999964 without rounding.
    expect(5087 - 5000.1).not.toBe(86.9); // guards the guard
    expect(computeDeviationMm(5087, 5000.1)).toBe(86.9);
  });

  it('is null when the operator could not read DCS — never zero', () => {
    // Zero would be indistinguishable from "DCS was exactly right" and would
    // corrupt the phone's rolling deviation average.
    expect(computeDeviationMm(5087, null)).toBeNull();
    expect(computeDeviationMm(5087, undefined)).toBeNull();
  });
});

describe('bandul range', () => {
  it('accepts the 0 and 99 boundaries', () => {
    for (const bandulSulfurMm of [0, BANDUL_MAX_MM]) {
      expect(validateReading({ heightMm: T401, tapeLengthMm: 2901, bandulSulfurMm })).toBeNull();
    }
  });

  it('rejects 100 — past what the bob gauge can physically read', () => {
    const error = validateReading({ heightMm: T401, tapeLengthMm: 2901, bandulSulfurMm: 100 });
    expect(error.code).toBe(ERROR_CODES.BANDUL_OUT_OF_RANGE);
    expect(error.message).toMatch(/0–99 mm/);
  });

  it('rejects negative sulfur height', () => {
    const error = validateReading({ heightMm: T401, tapeLengthMm: 2901, bandulSulfurMm: -1 });
    expect(error.code).toBe(ERROR_CODES.BANDUL_OUT_OF_RANGE);
  });
});

describe('tape length', () => {
  it('rejects a tape equal to tank height — it hit the floor', () => {
    const error = validateReading({ heightMm: T401, tapeLengthMm: T401, bandulSulfurMm: 35 });
    expect(error.code).toBe(ERROR_CODES.TAPE_TOO_LONG);
  });

  it('rejects a tape longer than the tank', () => {
    const error = validateReading({ heightMm: T401, tapeLengthMm: T401 + 1, bandulSulfurMm: 35 });
    expect(error.code).toBe(ERROR_CODES.TAPE_TOO_LONG);
  });

  it('accepts one millimetre short of the floor', () => {
    expect(validateReading({ heightMm: T401, tapeLengthMm: T401 - 1, bandulSulfurMm: 0 })).toBeNull();
  });
});

describe('validation order', () => {
  it('reports the bandul problem first when both bandul and tape are wrong', () => {
    // Deterministic ordering matters: the operator gets one message, and the
    // bob reading is the one they can act on immediately.
    const error = validateReading({ heightMm: T401, tapeLengthMm: T401 + 500, bandulSulfurMm: 150 });
    expect(error.code).toBe(ERROR_CODES.BANDUL_OUT_OF_RANGE);
  });

  it('never yields a negative level once bandul and tape pass', () => {
    // LEVEL_NEGATIVE is unreachable by construction: tape < height and
    // bandul >= 0 force a positive level. This guards the invariant so that
    // loosening the tape rule later cannot quietly start storing negatives.
    for (const tapeLengthMm of [0, 1, 2901, T401 - 1]) {
      for (const bandulSulfurMm of [0, 50, BANDUL_MAX_MM]) {
        const result = evaluateReading({ heightMm: T401, tapeLengthMm, bandulSulfurMm });
        expect(result.ok).toBe(true);
        expect(result.levelMm).toBeGreaterThan(0);
      }
    }
  });
});

describe('evaluateReading', () => {
  it('returns a rejection object rather than throwing, so one bad record cannot fail a sync batch', () => {
    const result = evaluateReading({
      heightMm: T401,
      tapeLengthMm: 2901,
      bandulSulfurMm: 100,
      dcsLevelMm: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(ERROR_CODES.BANDUL_OUT_OF_RANGE);
    expect(result).not.toHaveProperty('levelMm');
  });

  it('defaults a missing DCS reading to a null deviation', () => {
    const result = evaluateReading({ heightMm: T401, tapeLengthMm: 2901, bandulSulfurMm: 35 });
    expect(result.ok).toBe(true);
    expect(result.levelMm).toBe(5087);
    expect(result.deviationMm).toBeNull();
  });

  it('carries operator-facing messages in Indonesian', () => {
    const { error } = evaluateReading({ heightMm: T401, tapeLengthMm: T401, bandulSulfurMm: 0 });
    expect(error.message).toMatch(/Panjang meteran/);
  });
});
