import { classifyVisit, VISIT_CLASS } from '../behavioralClassifier';

// Fixed non-peak reference time so isPeakStagingHour() doesn't add its +15 and
// make the threshold maths ambiguous. 12:00 is outside all peak windows.
const NOON = new Date('2026-06-07T12:00:00');

describe('classifyVisit thresholds (70 staging / 20 drop-off)', () => {
  test('long dwell, slow, stationary → STAGING (score >= 70)', () => {
    const { classification, score } = classifyVisit(
      {
        dwellTime: 700, // +60
        avgSpeedInZone: 1, // +35 (<3)
        timeStationary: 200, // +30
        movedForwardGradually: true, // +40
        positionVariance: 2, // +20
        entrySpeed: 5, // +20 (<8)
      },
      null,
      NOON
    );
    expect(score).toBeGreaterThanOrEqual(70);
    expect(classification).toBe(VISIT_CLASS.STAGING);
  });

  test('fast pass-through → PASSING (score <= 20, avgSpeed > 10)', () => {
    const { classification, score } = classifyVisit(
      {
        dwellTime: 30, // -50 (<90)
        avgSpeedInZone: 25, // -80 (>10)
        entrySpeed: 30, // -20 (>15)
      },
      null,
      NOON
    );
    expect(score).toBeLessThanOrEqual(20);
    expect(classification).toBe(VISIT_CLASS.PASSING);
  });

  test('brief slow stop → DROP_OFF (score <= 20, avgSpeed <= 10)', () => {
    const { classification, score } = classifyVisit(
      {
        dwellTime: 30, // -50 (<90)
        avgSpeedInZone: 2, // +35 (<3), not >10 so not PASSING
        stoppedAtEntrance: true, // -40
        exitedSameSide: true, // -40
      },
      null,
      NOON
    );
    expect(score).toBeLessThanOrEqual(20);
    expect(classification).toBe(VISIT_CLASS.DROP_OFF);
  });

  test('mid-range score → UNKNOWN (between 20 and 70)', () => {
    const { classification, score } = classifyVisit(
      {
        dwellTime: 300, // +40 (180..600)
        avgSpeedInZone: 5, // no bonus (3..10)
        entrySpeed: 10, // no bonus (8..15)
      },
      null,
      NOON
    );
    expect(score).toBeGreaterThan(20);
    expect(score).toBeLessThan(70);
    expect(classification).toBe(VISIT_CLASS.UNKNOWN);
  });

  test('driver history score is clamped to ±25', () => {
    const base = { dwellTime: 150, avgSpeedInZone: 5 };
    const high = classifyVisit(base, { history_score: 1000 }, NOON);
    const low = classifyVisit(base, { history_score: -1000 }, NOON);
    const neutral = classifyVisit(base, { history_score: 0 }, NOON);
    expect(high.score - neutral.score).toBe(25);
    expect(neutral.score - low.score).toBe(25);
  });
});
