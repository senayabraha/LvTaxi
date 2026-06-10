import {
  DRIVER_STATUS,
  countsInStagingMath,
  classificationCountsAsStaged,
  classificationCountsAsNearby,
} from '../constants';

// Issue 2 / CNT-3: the client predicate and the SQL live_counts CTE must agree —
// only confirmed STAGING counts toward cars_staged; UNKNOWN is "nearby".

describe('staging-count reconciliation (JS predicate ↔ SQL classification)', () => {
  test('only STAGED driver status counts in staging math', () => {
    expect(countsInStagingMath(DRIVER_STATUS.STAGED)).toBe(true);
    for (const s of [
      DRIVER_STATUS.ACTIVE,
      DRIVER_STATUS.PASSIVE_FAR,
      DRIVER_STATUS.PASSIVE_NEAR,
      DRIVER_STATUS.EXIT_GRACE,
      DRIVER_STATUS.TRACKING_DISABLED,
      DRIVER_STATUS.OFF_DUTY,
    ]) {
      expect(countsInStagingMath(s)).toBe(false);
    }
  });

  test("only 'STAGING' classification counts as staged", () => {
    expect(classificationCountsAsStaged('STAGING')).toBe(true);
    for (const c of ['UNKNOWN', 'PASSING', 'DROP_OFF', 'ACTIVE']) {
      expect(classificationCountsAsStaged(c)).toBe(false);
    }
  });

  test("only 'UNKNOWN' classification counts as nearby", () => {
    expect(classificationCountsAsNearby('UNKNOWN')).toBe(true);
    for (const c of ['STAGING', 'PASSING', 'DROP_OFF', 'ACTIVE']) {
      expect(classificationCountsAsNearby(c)).toBe(false);
    }
  });

  test('staged and nearby buckets are mutually exclusive', () => {
    for (const c of ['STAGING', 'UNKNOWN', 'PASSING', 'DROP_OFF', 'ACTIVE']) {
      expect(classificationCountsAsStaged(c) && classificationCountsAsNearby(c)).toBe(false);
    }
  });
});
