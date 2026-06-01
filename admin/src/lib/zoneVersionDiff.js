// Pure diff logic for zone version restore (Phase 3).
//
// Compares the zones captured in a saved snapshot (zone_config_versions.snapshot,
// a FeatureCollection produced by buildZoneSnapshot) against the current
// staging_zones rows. Matching is by id first, then by name.
//
// No Supabase / React here — just data in, diff out — so it is easy to reason
// about and the restore writer (zoneStore.restoreZoneVersion) can consume it.

// Scalar config fields restored verbatim.
export const SCALAR_FIELDS = [
  'name',
  'lat',
  'lng',
  'radius_meters',
  'active',
  'is_coming_soon',
  'visible_to_drivers',
  'circle_enabled',
  'use_driven_polygon',
];

// Polygon fields shown/restored as summaries, never as raw JSON in the UI.
export const POLYGON_FIELDS = ['drawn_polygon', 'driven_polygon'];

function nameKey(n) {
  return (n ?? '').toString().trim().toLowerCase();
}

function matchKey(zone) {
  return zone.id ?? nameKey(zone.name);
}

// Extract zone-like objects (the stored `properties`) from a snapshot.
export function snapshotZones(snapshot) {
  const feats = Array.isArray(snapshot?.features) ? snapshot.features : [];
  return feats
    .map((f) => f?.properties ?? null)
    .filter((p) => p && (p.id || p.name));
}

function scalarEqual(a, b) {
  if (a == null && b == null) return true;
  return a === b;
}

// Returns one of: null (snapshot has no info — skip), 'unchanged', 'set',
// 'missing', 'changed'.
function polygonKind(snapHasKey, snapVal, curVal) {
  if (!snapHasKey) return null; // old snapshot without polygon data — don't touch
  const snapHas = !!snapVal;
  const curHas = !!curVal;
  if (!snapHas && !curHas) return 'unchanged';
  if (snapHas && !curHas) return 'set';
  if (!snapHas && curHas) return 'missing';
  return JSON.stringify(snapVal) === JSON.stringify(curVal) ? 'unchanged' : 'changed';
}

// Compares snapshot against current zones.
// Returns { toUpdate, toCreate, unchanged, notInSnapshot }.
//   toUpdate items: { current, snapshot, changes, patch }
//     changes[field] = { kind, from, to }  (only changed fields)
//     patch          = exact column values to write to staging_zones
export function computeRestoreDiff(snapshot, currentZones) {
  const snaps = snapshotZones(snapshot);
  const byId = new Map();
  const byName = new Map();
  for (const z of currentZones ?? []) {
    if (z.id) byId.set(z.id, z);
    byName.set(nameKey(z.name), z);
  }

  const matched = new Set();
  const toUpdate = [];
  const toCreate = [];
  const unchanged = [];

  for (const s of snaps) {
    let cur = s.id ? byId.get(s.id) : null;
    if (!cur) cur = byName.get(nameKey(s.name));

    if (!cur) {
      toCreate.push(s);
      continue;
    }
    matched.add(matchKey(cur));

    const changes = {};
    const patch = {};

    for (const f of SCALAR_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(s, f)) continue;
      if (!scalarEqual(s[f], cur[f])) {
        changes[f] = { kind: 'changed', from: cur[f], to: s[f] };
        patch[f] = s[f];
      }
    }

    for (const f of POLYGON_FIELDS) {
      const snapHasKey = Object.prototype.hasOwnProperty.call(s, f);
      const kind = polygonKind(snapHasKey, s[f], cur[f]);
      if (kind && kind !== 'unchanged') {
        changes[f] = {
          kind,
          from: cur[f] ? 'present' : 'absent',
          to: s[f] ? 'present' : 'absent',
        };
        patch[f] = s[f] ?? null;
      }
    }

    if (Object.keys(changes).length === 0) unchanged.push(cur);
    else toUpdate.push({ current: cur, snapshot: s, changes, patch });
  }

  const notInSnapshot = (currentZones ?? []).filter(
    (z) => !matched.has(matchKey(z))
  );

  return { toUpdate, toCreate, unchanged, notInSnapshot };
}
