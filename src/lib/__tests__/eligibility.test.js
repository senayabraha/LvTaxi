import { evaluateDriverEligibility } from '../eligibility';
import { PRESENCE_TTL_MS, MAX_PRESENCE_ACCURACY_METERS } from '../constants';

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [-115.171, 36.099],
      [-115.169, 36.099],
      [-115.169, 36.101],
      [-115.171, 36.101],
      [-115.171, 36.099],
    ],
  ],
};

const NOW = 1_700_000_000_000;

const zone = {
  id: 'zone-1',
  lat: 36.1,
  lng: -115.17,
  drawn_polygon: square,
  use_driven_polygon: false,
};

// A fully-eligible baseline; each test perturbs exactly one condition.
function baseline(overrides = {}) {
  return {
    now: NOW,
    zone,
    driver: {
      status: 'staged',
      tracking_enabled: true,
      deleted_at: null,
      ...overrides.driver,
    },
    presence: {
      current_zone_id: 'zone-1',
      classification: 'STAGING',
      last_ping_at: new Date(NOW - 10_000).toISOString(), // 10 s ago
      lat: 36.1,
      lng: -115.17, // inside the square
      accuracy: 10,
      ...overrides.presence,
    },
  };
}

describe('evaluateDriverEligibility (mirror of eligible_driver_presence)', () => {
  test('all 9 conditions satisfied → eligible', () => {
    const r = evaluateDriverEligibility(baseline());
    expect(r).toEqual({ eligible: true, reasons: [] });
  });

  test('tracking disabled → not eligible', () => {
    const r = evaluateDriverEligibility(baseline({ driver: { tracking_enabled: false } }));
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('tracking_disabled');
  });

  test('driver not staged → not eligible', () => {
    const r = evaluateDriverEligibility(baseline({ driver: { status: 'active' } }));
    expect(r.reasons).toContain('not_staged');
  });

  test('account soft-deleted → not eligible', () => {
    const r = evaluateDriverEligibility(
      baseline({ driver: { deleted_at: new Date(NOW).toISOString() } })
    );
    expect(r.reasons).toContain('account_inactive');
  });

  test('no current zone → not eligible', () => {
    const r = evaluateDriverEligibility(baseline({ presence: { current_zone_id: null } }));
    expect(r.reasons).toContain('no_zone');
  });

  test('classification not STAGING → not eligible', () => {
    const r = evaluateDriverEligibility(baseline({ presence: { classification: 'UNKNOWN' } }));
    expect(r.reasons).toContain('not_staging');
  });

  test('stale ping (just past TTL) → not eligible', () => {
    const r = evaluateDriverEligibility(
      baseline({ presence: { last_ping_at: new Date(NOW - PRESENCE_TTL_MS - 1).toISOString() } })
    );
    expect(r.reasons).toContain('stale_ping');
  });

  test('ping exactly at TTL boundary → still eligible', () => {
    const r = evaluateDriverEligibility(
      baseline({ presence: { last_ping_at: new Date(NOW - PRESENCE_TTL_MS).toISOString() } })
    );
    expect(r.eligible).toBe(true);
  });

  test('accuracy worse than ceiling → not eligible', () => {
    const r = evaluateDriverEligibility(
      baseline({ presence: { accuracy: MAX_PRESENCE_ACCURACY_METERS + 1 } })
    );
    expect(r.reasons).toContain('accuracy_too_low');
  });

  test('per-zone tighter ceiling overrides the global default', () => {
    const tightZone = { ...zone, max_accuracy_meters: 15 };
    const r = evaluateDriverEligibility({ ...baseline(), zone: tightZone, presence: { ...baseline().presence, accuracy: 25 } });
    expect(r.reasons).toContain('accuracy_too_low');
  });

  test('point outside the polygon → not eligible (zone_mismatch independent)', () => {
    const r = evaluateDriverEligibility(
      baseline({ presence: { lat: 36.2, lng: -115.0 } })
    );
    expect(r.reasons).toContain('outside_polygon');
  });

  test('zone without polygon → not eligible (no_polygon, mirrors geom NOT NULL)', () => {
    const noPoly = { id: 'zone-1', lat: 36.1, lng: -115.17 };
    const r = evaluateDriverEligibility({ ...baseline(), zone: noPoly });
    expect(r.reasons).toContain('no_polygon');
  });

  test('presence zone differs from evaluated zone → zone_mismatch', () => {
    const r = evaluateDriverEligibility(baseline({ presence: { current_zone_id: 'other' } }));
    expect(r.reasons).toContain('zone_mismatch');
  });
});
