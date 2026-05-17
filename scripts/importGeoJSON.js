#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * Usage:
 *   node scripts/importGeoJSON.js [path/to/file.geojson] [--dry-run] [--coming-soon]
 *
 * Defaults:
 *   path     → data/lvtaxi_zones.geojson
 *
 * Behavior:
 *   - Inserts each Polygon feature into staging_zones with:
 *       drawn_polygon = full GeoJSON feature
 *       lat / lng     = polygon centroid (for native circle wake-up)
 *       radius_meters = bounding-box half-diagonal (slightly larger than polygon)
 *       active        = true
 *       visible_to_drivers = true
 *       is_coming_soon = false (or true if --coming-soon)
 *   - Inserts 4 circle-only zones (Bellagio, Cosmopolitan, Fontainebleau, Palazzo)
 *     pulled from src/lib/constants.js — these have no polygon.
 *   - Inserts 8 Coming Soon placeholder zones (no polygon, no usable lat/lng).
 *   - Initializes zone_stats for everything inserted.
 *
 * Requires env: SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');
const { createClient } = require('@supabase/supabase-js');
const { STAGING_ZONES } = require('../src/lib/constants');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const url =
  process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!dryRun && (!url || !serviceKey)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const comingSoonAll = args.includes('--coming-soon');
const file =
  args.find((a) => !a.startsWith('--')) ||
  path.join(__dirname, '..', 'data', 'lvtaxi_zones.geojson');

const NAME_RENAMES = {
  'Shara Hotel': 'Sahara',
  'Shara Hotel ': 'Sahara',
};

// Circle-only zones: active staging spots that lack polygons in the GeoJSON.
// Pulled from src/lib/constants.js (which has lat/lng/radius).
const CIRCLE_ONLY_ZONES = [
  'Bellagio',
  'Cosmopolitan',
  'Fontainebleau',
  'Palazzo',
];

const COMING_SOON_ZONES = [
  'Circus Circus',
  'Encore',
  'Linq',
  'Harrahs',
  'Planet Hollywood',
  'Rio',
  'Gold Coast',
  'Palms',
];

function normalizeName(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return NAME_RENAMES[trimmed] || NAME_RENAMES[raw] || trimmed;
}

function polygonStats(feature) {
  const center = turf.centroid(feature);
  const [lng, lat] = center.geometry.coordinates;
  const bbox = turf.bbox(feature);
  const sw = turf.point([bbox[0], bbox[1]]);
  const ne = turf.point([bbox[2], bbox[3]]);
  const diagMeters = turf.distance(sw, ne, { units: 'meters' });
  const radius = Math.max(40, Math.ceil(diagMeters / 2) + 5);
  return { lat, lng, radius };
}

function readFeatures(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Input must be a GeoJSON FeatureCollection');
  }
  const out = [];
  for (const feature of data.features) {
    if (feature?.geometry?.type !== 'Polygon') {
      console.warn('  · skipping non-Polygon feature');
      continue;
    }
    const name = normalizeName(feature.properties?.Name || feature.properties?.name);
    if (!name) {
      console.warn('  · skipping unnamed feature');
      continue;
    }
    const { lat, lng, radius } = polygonStats(feature);
    out.push({
      name,
      lat,
      lng,
      radius_meters: radius,
      drawn_polygon: feature,
      use_driven_polygon: false,
      active: true,
      visible_to_drivers: true,
      is_coming_soon: comingSoonAll,
    });
  }
  return out;
}

function circleOnlyRows() {
  const lookup = new Map(STAGING_ZONES.map((z) => [z.name, z]));
  return CIRCLE_ONLY_ZONES.map((name) => {
    const src = lookup.get(name);
    if (!src) {
      throw new Error(
        `Circle-only zone "${name}" not found in src/lib/constants.js — fix the list`
      );
    }
    return {
      name: src.name,
      lat: src.lat,
      lng: src.lng,
      radius_meters: src.radius,
      drawn_polygon: null,
      use_driven_polygon: false,
      active: true,
      visible_to_drivers: true,
      is_coming_soon: false,
    };
  });
}

function comingSoonRows() {
  return COMING_SOON_ZONES.map((name) => ({
    name,
    lat: 36.1147,
    lng: -115.1728,
    radius_meters: 50,
    drawn_polygon: null,
    use_driven_polygon: false,
    active: true,
    visible_to_drivers: true,
    is_coming_soon: true,
  }));
}

async function upsertZones(supabase, rows) {
  const { data, error } = await supabase
    .from('staging_zones')
    .upsert(rows, { onConflict: 'name' })
    .select('id, name');
  if (error) throw error;
  return data;
}

async function initStats(supabase, zoneIds) {
  if (zoneIds.length === 0) return;
  const rows = zoneIds.map((id) => ({
    zone_id: id,
    cars_staged: 0,
    flow_rate_per_hour: 0,
    wait_time_minutes: null,
    last_updated: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('zone_stats')
    .upsert(rows, { onConflict: 'zone_id' });
  if (error) throw error;
}

async function main() {
  console.log(`Reading ${file}`);
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const polygonRows = readFeatures(file);
  const circleRows = circleOnlyRows();
  const comingRows = comingSoonRows();

  const allRows = [...polygonRows, ...circleRows, ...comingRows];

  console.log('\nSummary:');
  console.log(`  ${polygonRows.length} polygon zones (from GeoJSON)`);
  console.log(`  ${circleRows.length} circle-only zones (Bellagio/Cosmo/Vdara/Fontainebleau)`);
  console.log(`  ${comingRows.length} coming-soon placeholders`);
  console.log(`  ${allRows.length} total\n`);

  console.log('Polygon zones:');
  for (const r of polygonRows) {
    console.log(
      `  · ${r.name.padEnd(22)} center=${r.lat.toFixed(5)},${r.lng.toFixed(5)} r=${r.radius_meters}m`
    );
  }

  if (dryRun) {
    console.log('\n[--dry-run] Nothing written.');
    return;
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  console.log('\nUpserting staging_zones…');
  const inserted = await upsertZones(supabase, allRows);
  console.log(`  ✓ ${inserted.length} rows upserted`);

  console.log('Initializing zone_stats…');
  await initStats(supabase, inserted.map((r) => r.id));
  console.log(`  ✓ ${inserted.length} stat rows ready`);

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Import failed:', e.message ?? e);
  process.exit(1);
});
