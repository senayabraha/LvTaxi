import * as turf from '@turf/turf';
import { store } from '../store';
import { setGpsTier } from '../store/driversSlice';
import { supabase } from './supabase';
import {
  getDistanceMeters,
  startLocationTracking,
  stopLocationTracking,
  setGPSMode,
  onSmoothedLocation,
  GPS_MODE,
} from './locationEngine';
import { WORK_AREA_EXIT_GRACE_MS } from './constants';

// Tier definitions. The active tier drives the GPS sample rate and what
// counts as "engaged" for the rest of the app.
//
//   Tier 1: 1 s   — inside or right next to a staging zone (driver is working)
//   Tier 2: 5 s   — inside the work-area geofence but no zone nearby
//   Tier 3: 20 min — outside the work area; passive ping for analytics only
export const TIER = { ONE: 1, TWO: 2, THREE: 3 };

export const TIER_CONFIG = {
  [TIER.ONE]:   { mode: GPS_MODE.HIGH,    intervalMs: 1000,    label: '1s' },
  [TIER.TWO]:   { mode: GPS_MODE.LOW,     intervalMs: 5000,    label: '5s' },
  [TIER.THREE]: { mode: GPS_MODE.PASSIVE, intervalMs: 1_200_000, label: '20m' },
};

// Driver is considered to be "at" a staging zone for Tier 1 if they are
// within this radius of the zone centre (in addition to the zone's own
// polygon check, which handles inside-zone detection).
const STAGING_NEAR_METERS = 200;

// Work-area exit grace period: imported from constants so tierManager and the
// background tracking service use the same value (previously they disagreed:
// 20 min here vs 30 min in backgroundTrackingService).

let currentTier = TIER.THREE;
let workAreaPolygons = [];     // [{ id, name, polygon }]
let nearbyZones = [];          // cached list of all active zones with polygons
let exitTimerId = null;
let locationUnsub = null;
let started = false;

function getDriverId() {
  return store.getState().auth.session?.user?.id ?? null;
}

export function getCurrentTier() {
  return currentTier;
}

// ───────────────────────────── zone cache ─────────────────────────────────
// We refresh from the store's allZones (already loaded by useZones) plus
// fall back to a direct query if the store is empty.
export async function refreshZoneCache() {
  const stateZones = store.getState().zones.allZones;
  if (stateZones && stateZones.length > 0) {
    nearbyZones = stateZones.filter((z) => !z.is_coming_soon);
  } else {
    const { data, error } = await supabase
      .from('staging_zones')
      .select('id, name, lat, lng, radius_meters, drawn_polygon, driven_polygon, use_driven_polygon, is_coming_soon, active')
      .eq('active', true)
      .eq('is_coming_soon', false);
    if (error) {
      console.warn('[tierManager] zone cache refresh failed', error.message);
      return;
    }
    nearbyZones = data ?? [];
  }

  const { data: areas, error: areaErr } = await supabase
    .from('work_areas')
    .select('id, name, polygon')
    .eq('active', true);
  if (areaErr) {
    console.warn('[tierManager] work-area refresh failed', areaErr.message);
  } else {
    workAreaPolygons = areas ?? [];
  }
}

// ───────────────────────────── geometry ──────────────────────────────────
function polygonOf(zone) {
  if (!zone) return null;
  return zone.use_driven_polygon ? zone.driven_polygon : zone.drawn_polygon;
}

function pointInPolygon(lat, lng, polygon) {
  if (!polygon) return false;
  try {
    return turf.booleanPointInPolygon(turf.point([lng, lat]), polygon);
  } catch (err) {
    console.warn('[tierManager] polygon check failed', err);
    return false;
  }
}

export function isInsideWorkArea(lat, lng) {
  if (!workAreaPolygons || workAreaPolygons.length === 0) return false;
  for (const area of workAreaPolygons) {
    if (pointInPolygon(lat, lng, area.polygon)) return true;
  }
  return false;
}

export function detectStagingZone(lat, lng) {
  if (!nearbyZones || nearbyZones.length === 0) return null;
  // Polygon match is authoritative — check all polygon zones first.
  for (const zone of nearbyZones) {
    const poly = polygonOf(zone);
    if (poly && pointInPolygon(lat, lng, poly)) return zone;
  }
  // Proximity fallback only for zones that have no polygon at all.
  for (const zone of nearbyZones) {
    if (polygonOf(zone)) continue;
    if (zone.lat != null && zone.lng != null) {
      const d = getDistanceMeters(lat, lng, zone.lat, zone.lng);
      if (d <= STAGING_NEAR_METERS) return zone;
    }
  }
  return null;
}

// ─────────────────────────── tier transitions ────────────────────────────
async function restartGPSTask(tier) {
  const cfg = TIER_CONFIG[tier];
  if (!cfg) return;
  try {
    await setGPSMode(cfg.mode);
  } catch (err) {
    console.warn('[tierManager] setGPSMode failed, restarting tracking', err);
    try {
      stopLocationTracking();
      await startLocationTracking(cfg.mode);
    } catch (err2) {
      console.warn('[tierManager] restart failed', err2);
    }
  }
}

async function persistTier(tier, extra = {}) {
  const driverId = getDriverId();
  if (!driverId) return;
  const patch = { gps_tier: tier, ...extra };
  const { error } = await supabase
    .from('drivers')
    .update(patch)
    .eq('id', driverId);
  if (error) console.warn('[tierManager] persist tier failed', error.message);
}

function cancelExitTimer() {
  if (exitTimerId) {
    clearTimeout(exitTimerId);
    exitTimerId = null;
  }
}

async function switchToTier1() {
  cancelExitTimer();
  if (currentTier === TIER.ONE) return;
  currentTier = TIER.ONE;
  store.dispatch(setGpsTier(TIER.ONE));
  await restartGPSTask(TIER.ONE);
  await persistTier(TIER.ONE);
}

async function switchToTier2(opts = {}) {
  cancelExitTimer();
  if (currentTier === TIER.TWO) return;
  const wasPassive = currentTier === TIER.THREE;
  currentTier = TIER.TWO;
  store.dispatch(setGpsTier(TIER.TWO));
  await restartGPSTask(TIER.TWO);
  const extra = wasPassive || opts.markEntry
    ? { work_area_entry_time: new Date().toISOString(), work_area_exit_time: null }
    : {};
  await persistTier(TIER.TWO, extra);
}

async function switchToTier3() {
  cancelExitTimer();
  if (currentTier === TIER.THREE) return;
  currentTier = TIER.THREE;
  store.dispatch(setGpsTier(TIER.THREE));
  await restartGPSTask(TIER.THREE);
  await persistTier(TIER.THREE, {
    work_area_exit_time: new Date().toISOString(),
  });
}

// When the driver leaves the work area, wait 20 minutes before going Tier 3.
// If they come back during the grace period, the exit timer is cancelled.
function handleWorkAreaExit() {
  if (exitTimerId) return;
  exitTimerId = setTimeout(() => {
    exitTimerId = null;
    if (currentTier === TIER.TWO) {
      switchToTier3().catch((err) =>
        console.warn('[tierManager] tier3 transition failed', err)
      );
    }
  }, WORK_AREA_EXIT_GRACE_MS);
}

// ──────────────────────── main GPS-update handler ────────────────────────
export function processTierLogic(point) {
  if (!point || point.lat == null || point.lng == null) return;
  const { lat, lng } = point;
  const inWorkArea = isInsideWorkArea(lat, lng);

  if (inWorkArea) {
    const nearZone = detectStagingZone(lat, lng);
    if (nearZone) {
      if (currentTier !== TIER.ONE) {
        switchToTier1().catch((err) =>
          console.warn('[tierManager] tier1 transition failed', err)
        );
      }
    } else if (currentTier !== TIER.TWO) {
      switchToTier2().catch((err) =>
        console.warn('[tierManager] tier2 transition failed', err)
      );
    }
    return;
  }

  // Outside the work area.
  if (currentTier !== TIER.THREE) {
    // If we were on Tier 1 (zone) and the driver is now outside the work
    // area entirely, fall back to Tier 2 first and start the exit grace.
    if (currentTier === TIER.ONE) {
      switchToTier2().catch((err) =>
        console.warn('[tierManager] tier2 fallback failed', err)
      );
    }
    handleWorkAreaExit();
  }
}

// ─────────────────────────── public lifecycle ────────────────────────────
export async function startTierManager() {
  if (started) return;
  started = true;

  await refreshZoneCache();

  // Make sure location tracking is running before we try to drive it.
  try {
    await startLocationTracking(TIER_CONFIG[TIER.THREE].mode);
  } catch (err) {
    console.warn('[tierManager] startLocationTracking failed', err);
  }

  locationUnsub = onSmoothedLocation((pt) => {
    processTierLogic(pt);
  });

  // Initialise tier from current position if we already have one.
  const state = store.getState();
  const { currentLat, currentLng } = state.drivers;
  if (currentLat != null && currentLng != null) {
    processTierLogic({ lat: currentLat, lng: currentLng });
  }
}

export async function stopTierManager() {
  if (!started) return;
  started = false;
  cancelExitTimer();
  if (locationUnsub) {
    locationUnsub();
    locationUnsub = null;
  }
  currentTier = TIER.THREE;
}
