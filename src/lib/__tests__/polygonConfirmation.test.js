import {
  confirmStagingLocation,
  pointInZonePolygon,
  zoneHasPolygon,
  STAGING_FALLBACK_MAX_RADIUS_METERS,
} from '../polygonConfirmation';

// A small square polygon around (lat 36.10, lng -115.17), ~0.001° per side.
// GeoJSON rings are [lng, lat] and must be closed.
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

const polygonZone = {
  id: 'z-poly',
  name: 'Polygon Zone',
  lat: 36.1,
  lng: -115.17,
  radius_meters: 50,
  drawn_polygon: square,
  use_driven_polygon: false,
};

const noPolygonZone = {
  id: 'z-radius',
  name: 'Radius Zone',
  lat: 36.1,
  lng: -115.17,
  radius_meters: 50,
};

describe('pointInZonePolygon', () => {
  test('inside polygon → true', () => {
    expect(pointInZonePolygon(polygonZone, 36.1, -115.17)).toBe(true);
  });

  test('outside polygon → false (fail-closed)', () => {
    expect(pointInZonePolygon(polygonZone, 36.2, -115.0)).toBe(false);
  });

  test('zone without polygon → null', () => {
    expect(pointInZonePolygon(noPolygonZone, 36.1, -115.17)).toBeNull();
  });

  test('malformed polygon → false (fail-closed, not thrown)', () => {
    const bad = { ...polygonZone, drawn_polygon: { type: 'Polygon', coordinates: 'nonsense' } };
    expect(pointInZonePolygon(bad, 36.1, -115.17)).toBe(false);
  });

  test('respects use_driven_polygon selection', () => {
    const driven = {
      ...noPolygonZone,
      use_driven_polygon: true,
      driven_polygon: square,
      drawn_polygon: null,
    };
    expect(zoneHasPolygon(driven)).toBe(true);
    expect(pointInZonePolygon(driven, 36.1, -115.17)).toBe(true);
  });
});

describe('confirmStagingLocation', () => {
  test('polygon zone, inside → confirmed via polygon', () => {
    const r = confirmStagingLocation(polygonZone, 36.1, -115.17);
    expect(r).toMatchObject({ confirmed: true, method: 'polygon' });
  });

  test('polygon zone, outside → not confirmed', () => {
    const r = confirmStagingLocation(polygonZone, 36.2, -115.0);
    expect(r).toMatchObject({ confirmed: false, method: 'polygon' });
  });

  test('polygon-less zone, within real radius → confirmed via radius', () => {
    // ~30 m north of centre (0.00027° lat ≈ 30 m), inside the 50 m radius.
    const r = confirmStagingLocation(noPolygonZone, 36.10027, -115.17);
    expect(r.confirmed).toBe(true);
    expect(r.method).toBe('radius');
    expect(r.distance).toBeLessThanOrEqual(r.radius);
  });

  test('polygon-less zone, beyond radius but within the old flat 200 m → NOT confirmed', () => {
    // ~120 m north of centre: would have passed the old 200 m gate, fails 50 m.
    const r = confirmStagingLocation(noPolygonZone, 36.10108, -115.17);
    expect(r.confirmed).toBe(false);
    expect(r.method).toBe('radius');
  });

  test('radius fallback is capped at the hard ceiling', () => {
    const huge = { ...noPolygonZone, radius_meters: 100000 };
    // ~150 m north: beyond the 120 m cap even though radius_meters is huge.
    const r = confirmStagingLocation(huge, 36.10135, -115.17);
    expect(r.radius).toBe(STAGING_FALLBACK_MAX_RADIUS_METERS);
    expect(r.confirmed).toBe(false);
  });

  test('missing coordinates → not confirmed', () => {
    expect(confirmStagingLocation(polygonZone, null, null).confirmed).toBe(false);
  });
});
