// Lightweight smoke tests for the admin's PURE logic — no test framework, no
// Supabase, no DOM. Runs under plain Node (the files imported below have zero
// runtime dependencies). Exits non-zero on the first failure so CI can gate on
// it: `npm run smoke:logic`.

import {
  computeZoneHealth,
  getWaitMinutes,
  phaseOf,
} from '../src/lib/zoneHealth.js';
import { computeRestoreDiff } from '../src/lib/zoneVersionDiff.js';
import {
  parseGeoJson,
  geoJsonToBuilderPoints,
  builderPointsToGeoJson,
  getGeoJsonBounds,
  ERR,
} from '../src/lib/geojsonBuilder.js';

let failures = 0;
let count = 0;

function check(name, cond) {
  count += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

function eq(name, actual, expected) {
  check(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// ── getWaitMinutes ──────────────────────────────────────────────────────────
console.log('getWaitMinutes');
eq('prefers estimated_wait_minutes', getWaitMinutes({ estimated_wait_minutes: 12, wait_time_minutes: 99 }), 12);
eq('falls back to wait_time_minutes', getWaitMinutes({ wait_time_minutes: 7 }), 7);
eq('null when none', getWaitMinutes({}), null);
eq('null when stat missing', getWaitMinutes(null), null);

// ── phaseOf ─────────────────────────────────────────────────────────────────
console.log('phaseOf');
eq('Phase B', phaseOf({ use_driven_polygon: true, driven_polygon: {} }), 'B');
eq('Phase A', phaseOf({ drawn_polygon: {} }), 'A');
eq('Circle', phaseOf({}), 'Circle');
eq('A when driven flag but no driven polygon', phaseOf({ use_driven_polygon: true, drawn_polygon: {} }), 'A');

// ── computeZoneHealth ───────────────────────────────────────────────────────
console.log('computeZoneHealth');
eq(
  'inactive → UNKNOWN',
  computeZoneHealth({ active: false }, {}).health,
  'UNKNOWN'
);
eq(
  'coming soon → UNKNOWN',
  computeZoneHealth({ active: true, is_coming_soon: true }, {}).health,
  'UNKNOWN'
);
eq(
  'active hidden → CRITICAL',
  computeZoneHealth(
    { active: true, visible_to_drivers: false, driven_polygon: {} },
    { wait_status: 'OK', wait_confidence: 'HIGH' }
  ).health,
  'CRITICAL'
);
eq(
  'cars but no wait → CRITICAL',
  computeZoneHealth(
    { active: true, visible_to_drivers: true, driven_polygon: {} },
    { cars_staged: 3 }
  ).health,
  'CRITICAL'
);
eq(
  'low confidence → WARNING',
  computeZoneHealth(
    { active: true, visible_to_drivers: true, driven_polygon: {} },
    { cars_staged: 0, estimated_wait_minutes: 5, wait_confidence: 'LOW', wait_status: 'OK' }
  ).health,
  'WARNING'
);
eq(
  'no driven polygon → WARNING',
  computeZoneHealth(
    { active: true, visible_to_drivers: true },
    { cars_staged: 0, estimated_wait_minutes: 5, wait_confidence: 'HIGH', wait_status: 'OK' }
  ).health,
  'WARNING'
);
eq(
  'healthy → GOOD',
  computeZoneHealth(
    { active: true, visible_to_drivers: true, driven_polygon: {} },
    { cars_staged: 2, estimated_wait_minutes: 5, wait_confidence: 'HIGH', wait_status: 'OK' }
  ).health,
  'GOOD'
);

// ── computeRestoreDiff ──────────────────────────────────────────────────────
console.log('computeRestoreDiff');
function snap(props) {
  return { type: 'FeatureCollection', features: props.map((p) => ({ properties: p })) };
}

// Changed scalar (active flipped) on a matched zone.
{
  const snapshot = snap([{ id: 'z1', name: 'Bellagio', active: true, lat: 1, lng: 2, radius_meters: 100 }]);
  const current = [{ id: 'z1', name: 'Bellagio', active: false, lat: 1, lng: 2, radius_meters: 100 }];
  const d = computeRestoreDiff(snapshot, current);
  eq('one zone to update', d.toUpdate.length, 1);
  check('active is the changed field', d.toUpdate[0]?.changes?.active?.kind === 'changed');
  eq('patch carries restored value', d.toUpdate[0]?.patch?.active, true);
  eq('no creates', d.toCreate.length, 0);
}

// Identical → unchanged.
{
  const snapshot = snap([{ id: 'z1', name: 'A', active: true, lat: 1, lng: 2, radius_meters: 100 }]);
  const current = [{ id: 'z1', name: 'A', active: true, lat: 1, lng: 2, radius_meters: 100 }];
  const d = computeRestoreDiff(snapshot, current);
  eq('unchanged', d.unchanged.length, 1);
  eq('no updates', d.toUpdate.length, 0);
}

// Snapshot zone missing from DB → create; DB zone missing from snapshot → notInSnapshot.
{
  const snapshot = snap([{ id: 'z2', name: 'New', active: true, lat: 1, lng: 2, radius_meters: 100 }]);
  const current = [{ id: 'z9', name: 'Old', active: true, lat: 3, lng: 4, radius_meters: 50 }];
  const d = computeRestoreDiff(snapshot, current);
  eq('one to create', d.toCreate.length, 1);
  eq('one not in snapshot', d.notInSnapshot.length, 1);
  eq('not-in-snapshot is Old', d.notInSnapshot[0]?.name, 'Old');
}

// Match by name when id absent in snapshot.
{
  const snapshot = snap([{ name: 'Wynn', active: false, lat: 1, lng: 2, radius_meters: 100 }]);
  const current = [{ id: 'zX', name: 'Wynn', active: true, lat: 1, lng: 2, radius_meters: 100 }];
  const d = computeRestoreDiff(snapshot, current);
  eq('matched by name → update', d.toUpdate.length, 1);
  eq('no creates when name matches', d.toCreate.length, 0);
}

// Polygon summary: snapshot sets a polygon the current zone lacks.
{
  const snapshot = snap([{ id: 'z1', name: 'P', active: true, lat: 1, lng: 2, radius_meters: 100, drawn_polygon: { type: 'Feature' } }]);
  const current = [{ id: 'z1', name: 'P', active: true, lat: 1, lng: 2, radius_meters: 100, drawn_polygon: null }];
  const d = computeRestoreDiff(snapshot, current);
  eq('polygon kind = set', d.toUpdate[0]?.changes?.drawn_polygon?.kind, 'set');
}

function throws(name, fn, expectedMsg) {
  count += 1;
  try {
    fn();
    failures += 1;
    console.error(`  ✗ ${name} (did not throw)`);
  } catch (e) {
    if (expectedMsg && e.message !== expectedMsg) {
      failures += 1;
      console.error(`  ✗ ${name} (got "${e.message}")`);
    } else {
      console.log(`  ✓ ${name}`);
    }
  }
}

// ── geojsonBuilder: import ──────────────────────────────────────────────────
console.log('geojsonBuilder import');
{
  const poly = {
    type: 'Polygon',
    coordinates: [[[-115.1, 36.1], [-115.0, 36.1], [-115.0, 36.2], [-115.1, 36.1]]],
  };
  const r = geoJsonToBuilderPoints(poly);
  eq('polygon mode closed', r.mode, 'closed');
  eq('polygon drops closing dup (3 pts)', r.points.length, 3);
  eq('polygon lat from coord[1]', r.points[0].lat, 36.1);
}
{
  const line = { type: 'LineString', coordinates: [[-115.1, 36.1], [-115.0, 36.2]] };
  const r = geoJsonToBuilderPoints(line);
  eq('linestring mode open', r.mode, 'open');
  eq('linestring point count', r.points.length, 2);
}
{
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] } },
    ],
  };
  const parsed = parseGeoJson(JSON.stringify(fc));
  const r = geoJsonToBuilderPoints(parsed);
  eq('featurecollection point count', r.points.length, 3);
}

console.log('geojsonBuilder errors');
throws('invalid JSON', () => parseGeoJson('{not json'), ERR.INVALID_JSON);
throws('valid JSON but not GeoJSON', () => parseGeoJson('{"foo":1}'), ERR.NOT_GEOJSON);
throws(
  'unsupported geometry (Point)',
  () => geoJsonToBuilderPoints({ type: 'Point', coordinates: [0, 0] }),
  ERR.UNSUPPORTED
);
throws(
  'empty coordinates',
  () => geoJsonToBuilderPoints({ type: 'LineString', coordinates: [] }),
  ERR.EMPTY
);

// ── geojsonBuilder: export ──────────────────────────────────────────────────
console.log('geojsonBuilder export');
{
  const pts = [{ lat: 36.1, lng: -115.1 }, { lat: 36.1, lng: -115.0 }, { lat: 36.2, lng: -115.0 }];
  const f = builderPointsToGeoJson(pts, { mode: 'closed', name: 'venetian' });
  const ring = f.geometry.coordinates[0];
  eq('export polygon geometry type', f.geometry.type, 'Polygon');
  eq('export polygon ring closed', JSON.stringify(ring[0]), JSON.stringify(ring[ring.length - 1]));
  eq('export polygon geometry_mode', f.properties.geometry_mode, 'polygon');
  eq('export polygon keeps name', f.properties.name, 'venetian');
  eq('export source builder', f.properties.source, 'builder');
}
{
  const pts = [{ lat: 36.1, lng: -115.1 }, { lat: 36.2, lng: -115.0 }];
  const f = builderPointsToGeoJson(pts, { mode: 'open', bufferMeters: 5 });
  eq('export path geometry type', f.geometry.type, 'LineString');
  eq('export path geometry_mode', f.properties.geometry_mode, 'path');
  eq('export path buffer_meters', f.properties.buffer_meters, 5);
}
{
  const b = getGeoJsonBounds([{ lat: 36.1, lng: -115.1 }, { lat: 36.3, lng: -115.0 }]);
  eq('bounds south', b[0][0], 36.1);
  eq('bounds east', b[1][1], -115.0);
}

console.log(`\n${count - failures}/${count} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All smoke checks passed ✓');
