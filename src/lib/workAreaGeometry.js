// ── Work-area & staging-zone geometry (polygon is the source of truth) ───────
// The automatic tracking architecture decides a driver's state from where they
// are relative to two kinds of polygon:
//
//   • work-area polygon  → ACTIVE (inside) vs PASSIVE/EXIT_GRACE (outside)
//   • staging-zone polygon → STAGED (inside) and which queue they count toward
//
// IMPORTANT: native circular geofences are NOT the source of truth here. They
// only exist (in geofenceEngine) as a cheap OS wake-up. The polygon checks below
// are authoritative. If we cannot confirm the driver is inside a work-area
// polygon, we FAIL SAFE and treat them as outside (passive) — we never
// auto-activate a driver we cannot positively place inside the work area.
//
// This module deliberately keeps its own small cache so it can run inside the
// background TaskManager tasks, where Redux may be empty / not hydrated. It
// reuses the same polygon shapes and Supabase tables (work_areas, staging_zones)
// that tierManager.js already uses, so we don't duplicate that logic's intent.

import * as turf from '@turf/turf';
import { store } from '../store';
import { supabase } from './supabase';
import { getDistanceMeters } from './locationEngine';
import {
  DRIVER_STATUS,
  PASSIVE_NEAR_THRESHOLD_METERS,
} from './constants';

// Same "near a zone centre" radius tierManager uses, so polygon-less zones still
// behave consistently between the foreground tier system and background tasks.
const STAGING_NEAR_METERS = 200;

// Re-fetch the polygon cache at most this often (background tasks fire slowly, so
// this keeps us from hammering Supabase while still picking up admin edits).
const CACHE_TTL_MS = 5 * 60 * 1000;

let workAreaPolygons = []; // [{ id, name, polygon }]
let stagingZones = [];     // staging_zones rows (with drawn/driven polygons)
let lastRefreshAt = 0;

function polygonOfZone(zone) {
  if (!zone) return null;
  return zone.use_driven_polygon ? zone.driven_polygon : zone.drawn_polygon;
}

// Accept either a GeoJSON Feature or a bare geometry (both are stored in jsonb).
function asPolygonFeature(polygon) {
  if (!polygon) return null;
  return polygon.type === 'Feature' ? polygon : turf.feature(polygon);
}

function pointInPolygon(lat, lng, polygon) {
  if (!polygon) return false;
  try {
    return turf.booleanPointInPolygon(turf.point([lng, lat]), polygon);
  } catch (err) {
    console.warn('[workAreaGeometry] polygon check failed', err);
    return false;
  }
}

// ── Cache refresh ────────────────────────────────────────────────────────────
// Prefer the already-loaded zone store (foreground), fall back to Supabase
// (background headless launch where the store is empty).
export async function refreshWorkAreaCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRefreshAt < CACHE_TTL_MS && workAreaPolygons.length) {
    return;
  }

  // Staging zones — use the store if populated, otherwise query directly.
  const stateZones = store.getState().zones?.allZones;
  if (stateZones && stateZones.length > 0) {
    stagingZones = stateZones.filter((z) => z.active !== false && !z.is_coming_soon);
  } else {
    const { data, error } = await supabase
      .from('staging_zones')
      .select(
        'id, name, lat, lng, radius_meters, drawn_polygon, driven_polygon, use_driven_polygon, is_coming_soon, active'
      )
      .eq('active', true)
      .eq('is_coming_soon', false);
    if (error) {
      console.warn('[workAreaGeometry] staging zone refresh failed', error.message);
    } else {
      stagingZones = data ?? [];
    }
  }

  // Work areas are always read from Supabase (not kept in the zone store).
  const { data: areas, error: areaErr } = await supabase
    .from('work_areas')
    .select('id, name, polygon')
    .eq('active', true);
  if (areaErr) {
    console.warn('[workAreaGeometry] work-area refresh failed', areaErr.message);
  } else {
    workAreaPolygons = areas ?? [];
  }

  lastRefreshAt = now;
}

export function getWorkAreaPolygonCount() {
  return workAreaPolygons.length;
}

// ── Inside / outside the work area ───────────────────────────────────────────
// Fail-safe: with no polygons loaded we report "not inside" so we never
// auto-activate a driver we cannot positively place inside the work area.
export function isInsideWorkAreaPolygon(lat, lng) {
  if (lat == null || lng == null) return false;
  if (!workAreaPolygons || workAreaPolygons.length === 0) return false;
  for (const area of workAreaPolygons) {
    if (pointInPolygon(lat, lng, area.polygon)) return true;
  }
  return false;
}

// Shortest distance (metres) from the point to the nearest work-area polygon
// boundary. Returns 0 when inside, Infinity when no polygons are available.
export function distanceToWorkAreaMeters(lat, lng) {
  if (lat == null || lng == null) return Infinity;
  if (!workAreaPolygons || workAreaPolygons.length === 0) return Infinity;
  if (isInsideWorkAreaPolygon(lat, lng)) return 0;

  const pt = turf.point([lng, lat]);
  let min = Infinity;
  for (const area of workAreaPolygons) {
    const feature = asPolygonFeature(area.polygon);
    if (!feature) continue;
    try {
      const line = turf.polygonToLine(feature);
      // polygonToLine can yield a MultiLineString (polygon with holes); take the
      // outer ring distance which is what matters for "how far outside".
      const km = turf.pointToLineDistance(pt, line, { units: 'kilometers' });
      const meters = km * 1000;
      if (meters < min) min = meters;
    } catch (err) {
      console.warn('[workAreaGeometry] distance-to-work-area failed', err);
    }
  }
  return min;
}

// Classify an OUTSIDE driver as PASSIVE_NEAR or PASSIVE_FAR. Callers should only
// use this once they've confirmed the driver is NOT inside the work area.
export function classifyPassiveDistance(lat, lng) {
  const d = distanceToWorkAreaMeters(lat, lng);
  if (d <= PASSIVE_NEAR_THRESHOLD_METERS) return DRIVER_STATUS.PASSIVE_NEAR;
  return DRIVER_STATUS.PASSIVE_FAR;
}

// Detect which staging-zone polygon (the queue source of truth) the point falls
// in. Falls back to a small radius around the zone centre for zones that have no
// polygon yet, mirroring tierManager.detectStagingZone.
export function detectStagingZoneFromPoint(lat, lng) {
  if (lat == null || lng == null) return null;
  if (!stagingZones || stagingZones.length === 0) return null;
  for (const zone of stagingZones) {
    const poly = polygonOfZone(zone);
    if (poly && pointInPolygon(lat, lng, poly)) return zone;
  }
  // Polygon miss → fall back to centre proximity for polygon-less zones only.
  for (const zone of stagingZones) {
    if (polygonOfZone(zone)) continue;
    if (zone.lat != null && zone.lng != null) {
      const d = getDistanceMeters(lat, lng, zone.lat, zone.lng);
      if (d <= STAGING_NEAR_METERS) return zone;
    }
  }
  return null;
}
