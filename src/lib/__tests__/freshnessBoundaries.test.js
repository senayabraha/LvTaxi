import {
  isPresenceFresh,
  secondsSincePing,
  isExitGraceExpired,
} from '../presenceFreshness';
import { PRESENCE_TTL_MS, WORK_AREA_EXIT_GRACE_MS } from '../constants';

const NOW = 1_700_000_000_000;

describe('90 s presence TTL boundary', () => {
  test('ping exactly at the TTL is still fresh', () => {
    expect(isPresenceFresh(new Date(NOW - PRESENCE_TTL_MS).toISOString(), NOW)).toBe(true);
  });

  test('one ms past the TTL is stale', () => {
    expect(isPresenceFresh(new Date(NOW - PRESENCE_TTL_MS - 1).toISOString(), NOW)).toBe(false);
  });

  test('fresh ping (10 s) is fresh', () => {
    expect(isPresenceFresh(new Date(NOW - 10_000).toISOString(), NOW)).toBe(true);
  });

  test('null / unparseable → not fresh', () => {
    expect(isPresenceFresh(null, NOW)).toBe(false);
    expect(isPresenceFresh('not-a-date', NOW)).toBe(false);
  });

  test('secondsSincePing', () => {
    expect(secondsSincePing(new Date(NOW - 45_000).toISOString(), NOW)).toBe(45);
    expect(secondsSincePing(null, NOW)).toBeNull();
  });
});

describe('30 min exit-grace boundary', () => {
  test('just under 30 min → not expired', () => {
    expect(isExitGraceExpired(NOW - (WORK_AREA_EXIT_GRACE_MS - 1), NOW)).toBe(false);
  });

  test('exactly 30 min → expired', () => {
    expect(isExitGraceExpired(NOW - WORK_AREA_EXIT_GRACE_MS, NOW)).toBe(true);
  });

  test('well past 30 min → expired', () => {
    expect(isExitGraceExpired(NOW - 2 * WORK_AREA_EXIT_GRACE_MS, NOW)).toBe(true);
  });

  test('no start timestamp → not expired', () => {
    expect(isExitGraceExpired(null, NOW)).toBe(false);
  });
});
