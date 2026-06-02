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

console.log(`\n${count - failures}/${count} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All smoke checks passed ✓');
