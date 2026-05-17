import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as turf from '@turf/turf';
import { store } from '../store';
import { zoneEntered, zoneExited } from '../store/driversSlice';
import { setTop20Zones } from '../store/zonesSlice';
import { supabase } from './supabase';
import { getDistanceMeters } from './locationEngine';
import { startRecording, stopRecording } from './trajectoryRecorder';
import { processZoneExit } from './visitProcessor';
import { incrementZoneCount } from './zoneStatsEngine';
import { SORT_OPTIONS } from './constants';

export const GEOFENCE_TASK = 'LVTAXI_GEOFENCE_TASK';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const NEAREST_REFRESH_METERS = 804.672;
const MIN_GEOFENCE_REFRESH_MS = 30 * 1000;

const activeVisits = new Map();
const activeZoneById = new Map();
let lastRefreshAnchor = null;
let refreshTimer = null;
let lastGeofenceUpdateAt = 0;
let pendingDebounceTimer = null;

function getZoneById(id) {
  if (activeZoneById.has(id)) return activeZoneById.get(id);
  const all = store.getState().zones.allZones;
  return all.find((z) => z.id === id) ?? null;
}

// Hybrid layer: native circle wakes us up, polygon refines.
// Returns true if no polygon (trust the circle).
function verifyWithPolygon(zone, lat, lng) {
  if (!zone) return true;
  const polygon = zone.use_driven_polygon
    ? zone.driven_polygon
    : zone.drawn_polygon;
  if (!polygon) return true;
  try {
    return turf.booleanPointInPolygon(turf.point([lng, lat]), polygon);
  } catch (err) {
    console.warn('[geofenceEngine] polygon check failed', err);
    return true;
  }
}

async function handleEnter(zoneId) {
  const zone = getZoneById(zoneId);
  const driverId = store.getState().auth.session?.user?.id ?? null;

  // Native geofence is wider than the actual lane — confirm with polygon.
  if (zone?.drawn_polygon || zone?.driven_polygon) {
    let pos = null;
    try {
      pos = await Location.getLastKnownPositionAsync({
        maxAge: 30_000,
      });
    } catch (err) {
      console.warn('[geofenceEngine] getLastKnownPosition failed', err);
    }
    if (pos?.coords) {
      const inside = verifyWithPolygon(
        zone,
        pos.coords.latitude,
        pos.coords.longitude
      );
      if (!inside) {
        console.log('[geofenceEngine] polygon rejected enter for', zone.name);
        return;
      }
    }
  }

  store.dispatch(zoneEntered(zoneId));

  let visitId = null;
  if (driverId) {
    const { data, error } = await supabase
      .from('zone_visits')
      .insert({
        driver_id: driverId,
        zone_id: zoneId,
        entered_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[geofenceEngine] insert zone_visit failed', error);
    } else {
      visitId = data.id;
      activeVisits.set(zoneId, visitId);
    }
  }

  incrementZoneCount(zoneId).catch((err) =>
    console.warn('[geofenceEngine] incrementZoneCount failed', err)
  );

  startRecording(
    visitId,
    zone ? { lat: zone.lat, lng: zone.lng } : null
  );
}

async function handleExit(zoneId) {
  const state = store.getState();
  const entryTime = state.drivers.zoneEntryTime;
  const driverId = state.auth.session?.user?.id ?? null;
  store.dispatch(zoneExited());

  const visitId = activeVisits.get(zoneId) ?? null;
  activeVisits.delete(zoneId);

  const { gpsPoints, features } = await stopRecording({ persist: false });

  const dwellSeconds = entryTime
    ? Math.round((Date.now() - entryTime) / 1000)
    : null;

  if (visitId) {
    const { error } = await supabase
      .from('zone_visits')
      .update({
        exited_at: new Date().toISOString(),
        dwell_seconds: dwellSeconds,
        entry_speed: features.entrySpeed,
        exit_speed: features.exitSpeed,
        avg_speed: features.avgSpeedInZone,
        heading_change: features.headingChange,
        forward_creep: features.forwardCreep > 0,
      })
      .eq('id', visitId);
    if (error) {
      console.warn('[geofenceEngine] update zone_visit failed', error);
    }
  }

  if (visitId && driverId) {
    const zoneCenter = (() => {
      const z = getZoneById(zoneId);
      return z ? { lat: z.lat, lng: z.lng } : null;
    })();
    try {
      await processZoneExit(visitId, driverId, zoneId, gpsPoints, zoneCenter);
    } catch (err) {
      console.warn('[geofenceEngine] processZoneExit failed', err);
    }
  }

  return { visitId, features };
}

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[geofenceEngine] task error', error);
    return;
  }
  const { eventType, region } = data ?? {};
  if (!region) return;

  try {
    if (eventType === Location.GeofencingEventType.Enter) {
      await handleEnter(region.identifier);
    } else if (eventType === Location.GeofencingEventType.Exit) {
      await handleExit(region.identifier);
    }
  } catch (err) {
    console.warn('[geofenceEngine] handler failed', err);
  }
});

export function getTop20Zones(allZones, sortOption, driverLat, driverLng) {
  if (!allZones || allZones.length === 0) return [];
  const stats = store.getState().zones.stats;
  // Coming Soon zones are placeholders only — never spend a geofence slot.
  const list = allZones.filter((z) => !z.is_coming_soon);

  if (sortOption === SORT_OPTIONS.NEAREST) {
    if (driverLat == null || driverLng == null) {
      return list.slice(0, 20);
    }
    list.sort((a, b) => {
      const da = getDistanceMeters(driverLat, driverLng, a.lat, a.lng);
      const db = getDistanceMeters(driverLat, driverLng, b.lat, b.lng);
      return da - db;
    });
  } else if (sortOption === SORT_OPTIONS.FLOW) {
    list.sort((a, b) => {
      const fa = stats[a.id]?.flow_rate_per_hour ?? 0;
      const fb = stats[b.id]?.flow_rate_per_hour ?? 0;
      return fb - fa;
    });
  } else if (sortOption === SORT_OPTIONS.WAIT) {
    list.sort((a, b) => {
      const wa = stats[a.id]?.wait_time_minutes ?? Number.POSITIVE_INFINITY;
      const wb = stats[b.id]?.wait_time_minutes ?? Number.POSITIVE_INFINITY;
      return wa - wb;
    });
  }

  return list.slice(0, 20);
}

async function applyGeofences(top20Zones) {
  const regions = (top20Zones ?? [])
    .filter((z) => z && z.lat != null && z.lng != null)
    .map((z) => ({
      identifier: z.id,
      latitude: z.lat,
      longitude: z.lng,
      radius: z.radius_meters ?? z.radius ?? 80,
      notifyOnEnter: true,
      notifyOnExit: true,
    }));

  activeZoneById.clear();
  for (const z of top20Zones ?? []) activeZoneById.set(z.id, z);

  try {
    const isRunning = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
    if (isRunning) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch (err) {
    console.warn('[geofenceEngine] stopGeofencingAsync failed', err);
  }

  if (regions.length === 0) return;

  try {
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    lastGeofenceUpdateAt = Date.now();
  } catch (err) {
    console.warn('[geofenceEngine] startGeofencingAsync failed', err);
  }
}

export function updateActiveGeofences(top20Zones) {
  const elapsed = Date.now() - lastGeofenceUpdateAt;
  if (elapsed >= MIN_GEOFENCE_REFRESH_MS) {
    return applyGeofences(top20Zones);
  }
  if (pendingDebounceTimer) clearTimeout(pendingDebounceTimer);
  const wait = MIN_GEOFENCE_REFRESH_MS - elapsed;
  pendingDebounceTimer = setTimeout(() => {
    pendingDebounceTimer = null;
    applyGeofences(top20Zones);
  }, wait);
}

function recomputeAndApply() {
  const state = store.getState();
  const { allZones } = state.zones;
  const { activeSort, currentLat, currentLng } = {
    activeSort: state.zones.activeSort,
    currentLat: state.drivers.currentLat,
    currentLng: state.drivers.currentLng,
  };
  const top20 = getTop20Zones(allZones, activeSort, currentLat, currentLng);
  store.dispatch(setTop20Zones(top20));
  updateActiveGeofences(top20);

  if (
    activeSort === SORT_OPTIONS.NEAREST &&
    currentLat != null &&
    currentLng != null
  ) {
    lastRefreshAnchor = { lat: currentLat, lng: currentLng };
  } else {
    lastRefreshAnchor = null;
  }
}

let unsubscribeStore = null;

export function startGeofenceManager() {
  if (refreshTimer) return;

  recomputeAndApply();

  let prevSort = store.getState().zones.activeSort;
  let prevZonesLength = store.getState().zones.allZones.length;
  let prevStatsKey = JSON.stringify(
    Object.keys(store.getState().zones.stats).sort()
  );

  unsubscribeStore = store.subscribe(() => {
    const state = store.getState();
    const { activeSort, allZones, stats } = state.zones;
    const { currentLat, currentLng } = state.drivers;

    const sortChanged = activeSort !== prevSort;
    const zonesChanged = allZones.length !== prevZonesLength;
    const statsKey = JSON.stringify(Object.keys(stats).sort());
    const statsKeysChanged = statsKey !== prevStatsKey;

    let movedFar = false;
    if (
      activeSort === SORT_OPTIONS.NEAREST &&
      lastRefreshAnchor &&
      currentLat != null &&
      currentLng != null
    ) {
      const moved = getDistanceMeters(
        lastRefreshAnchor.lat,
        lastRefreshAnchor.lng,
        currentLat,
        currentLng
      );
      if (moved >= NEAREST_REFRESH_METERS) movedFar = true;
    } else if (
      activeSort === SORT_OPTIONS.NEAREST &&
      !lastRefreshAnchor &&
      currentLat != null &&
      currentLng != null
    ) {
      movedFar = true;
    }

    if (sortChanged || zonesChanged || statsKeysChanged || movedFar) {
      prevSort = activeSort;
      prevZonesLength = allZones.length;
      prevStatsKey = statsKey;
      recomputeAndApply();
    }
  });

  refreshTimer = setInterval(recomputeAndApply, REFRESH_INTERVAL_MS);
}

export async function stopGeofenceManager() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (pendingDebounceTimer) {
    clearTimeout(pendingDebounceTimer);
    pendingDebounceTimer = null;
  }
  if (unsubscribeStore) {
    unsubscribeStore();
    unsubscribeStore = null;
  }
  try {
    const isRunning = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
    if (isRunning) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  } catch (err) {
    console.warn('[geofenceEngine] stop failed', err);
  }
  activeZoneById.clear();
  activeVisits.clear();
  lastRefreshAnchor = null;
}
