import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as turf from '@turf/turf';
import * as Sentry from '@sentry/react-native';
import { store } from '../store';
import { zoneEntered, zoneExited } from '../store/driversSlice';
import { setTop20Zones } from '../store/zonesSlice';
import { supabase } from './supabase';
import { getDistanceMeters } from './locationEngine';
import { startRecording, stopRecording } from './trajectoryRecorder';
import { processZoneExit } from './visitProcessor';
import { maybeSendPresenceHeartbeat } from './presenceHeartbeat';
import { persistDriverStatus } from './backgroundTracking/backgroundTrackingService';
import { DRIVER_STATUS, SORT_OPTIONS } from './constants';

export const GEOFENCE_TASK = 'LVTAXI_GEOFENCE_TASK';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const NEAREST_REFRESH_METERS = 804.672;
const MIN_GEOFENCE_REFRESH_MS = 30 * 1000;

const activeVisits = new Map();
const activeZoneById = new Map();
const pendingEntries = new Map(); // zoneId → { timerId, startedAt }
const RETRY_INTERVAL_MS = 10_000;
const MAX_RETRY_MS = 120_000;
let lastRefreshAnchor = null;
let refreshTimer = null;
let lastGeofenceUpdateAt = 0;
let pendingDebounceTimer = null;
let isRecomputing = false;

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

async function completeHandleEnter(zoneId, zone, driverId) {
  // Set sentinel BEFORE any async work so the handleEnter guard keeps re-fires out
  // even while the insert is in flight.
  activeVisits.set(zoneId, null);
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

  // A polygon-confirmed staging-zone entry IS the "staged" signal. Promote and
  // persist BEFORE the heartbeat: maybeSendPresenceHeartbeat() drops any write
  // while status is passive (see isHeartbeatStatus), so without this the forced
  // write below is silently discarded and the driver is never counted even though
  // the UI already shows "You are here". persistDriverStatus mirrors
  // setStatus(STAGED) into Redux and writes drivers.status / current_zone_id.
  await persistDriverStatus(driverId, DRIVER_STATUS.STAGED, {
    current_zone_id: zoneId,
    work_area_exit_started_at: null,
  });

  // Live counts come from active_driver_presence — no legacy counter here.
  // Force a presence write immediately on zone enter so the driver is counted
  // without waiting for the next throttled heartbeat tick. Status is now STAGED,
  // so the heartbeat guard passes and the classification is STAGING.
  const drivers = store.getState().drivers;
  if (driverId && drivers.currentLat != null && drivers.currentLng != null) {
    maybeSendPresenceHeartbeat({
      driverId,
      zoneId,
      classification: 'STAGING',
      lat: drivers.currentLat,
      lng: drivers.currentLng,
      speed: drivers.speed,
      accuracy: drivers.rawAccuracy,
      heading: drivers.heading,
      visitId,
      force: true,
    }).catch((err) =>
      console.warn('[geofenceEngine] presence upsert on enter failed', err)
    );
  }

  startRecording(
    visitId,
    zone ? { lat: zone.lat, lng: zone.lng } : null
  );
}

async function handleEnter(zoneId) {
  // Guard against Expo re-firing Enter or a polygon-retry racing with a fresh Enter.
  // activeVisits is set inside completeHandleEnter and cleared on exit; pendingEntries
  // is set while the polygon retry loop is running.
  if (activeVisits.has(zoneId) || pendingEntries.has(zoneId)) return;

  const zone = getZoneById(zoneId);
  const driverId = store.getState().auth.session?.user?.id ?? null;

  // Native geofence is wider than the actual lane — confirm with polygon.
  if (zone?.drawn_polygon || zone?.driven_polygon) {
    let pos = null;
    try {
      pos = await Location.getLastKnownPositionAsync({ maxAge: 30_000 });
    } catch (err) {
      console.warn('[geofenceEngine] getLastKnownPosition failed', err);
    }
    if (pos?.coords) {
      const inside = verifyWithPolygon(zone, pos.coords.latitude, pos.coords.longitude);
      if (!inside) {
        // Driver may be on the loop road heading toward the staging area.
        // Retry polygon check every 10s for up to 2 minutes before discarding.
        if (!pendingEntries.has(zoneId)) {
          console.log('[geofenceEngine] polygon check failed, deferring entry for', zone?.name);
          const startedAt = Date.now();
          const timerId = setInterval(async () => {
            if (Date.now() - startedAt >= MAX_RETRY_MS) {
              clearInterval(timerId);
              pendingEntries.delete(zoneId);
              console.log('[geofenceEngine] deferred entry timed out for', zone?.name);
              return;
            }
            let retryPos = null;
            try {
              retryPos = await Location.getLastKnownPositionAsync({ maxAge: 15_000 });
            } catch {}
            if (retryPos?.coords) {
              const nowInside = verifyWithPolygon(zone, retryPos.coords.latitude, retryPos.coords.longitude);
              if (nowInside) {
                clearInterval(timerId);
                pendingEntries.delete(zoneId);
                console.log('[geofenceEngine] deferred entry confirmed for', zone?.name);
                await completeHandleEnter(zoneId, zone, driverId);
              }
            }
          }, RETRY_INTERVAL_MS);
          pendingEntries.set(zoneId, { timerId, startedAt });
        }
        return;
      }
    }
  }

  await completeHandleEnter(zoneId, zone, driverId);
}

async function handleExit(zoneId) {
  // If the driver exits before the deferred entry confirmed, cancel the retry.
  if (pendingEntries.has(zoneId)) {
    const { timerId } = pendingEntries.get(zoneId);
    clearInterval(timerId);
    pendingEntries.delete(zoneId);
    console.log('[geofenceEngine] deferred entry cancelled on exit for', zoneId);
    return;
  }

  const state = store.getState();
  const entryTime = state.drivers.zoneEntryTime;
  const driverId = state.auth.session?.user?.id ?? null;
  store.dispatch(zoneExited());

  const visitId = activeVisits.get(zoneId) ?? null;
  activeVisits.delete(zoneId);

  // stopRecording is synchronous and never writes — persistence happens once in
  // processZoneExit below. We just collect the buffered points + features here.
  const { gpsPoints, features } = stopRecording();

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
    Sentry.captureException(error, {
      tags: { source: 'geofenceEngine', phase: 'task' },
    });
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
    Sentry.captureException(err, {
      tags: { source: 'geofenceEngine', phase: 'handler' },
      extra: { eventType, regionId: region?.identifier },
    });
  }
});

// Wait-sort key. Prefer the new blended estimate; fall back to legacy
// wait_time_minutes so old data still orders. Zones with no usable estimate
// (insufficient data / no recent movement) sort last instead of jumping to the
// top just because legacy wait was null/zero.
export function getWaitSortValue(stat) {
  if (!stat) return Number.POSITIVE_INFINITY;
  if (
    stat.wait_status === 'INSUFFICIENT_DATA' ||
    stat.wait_status === 'NO_RECENT_MOVEMENT'
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    stat.estimated_wait_minutes ??
    stat.wait_time_minutes ??
    Number.POSITIVE_INFINITY
  );
}

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
      const wa = getWaitSortValue(stats[a.id]);
      const wb = getWaitSortValue(stats[b.id]);
      return wa - wb;
    });
  }

  return list.slice(0, 20);
}

async function applyGeofences(top20Zones) {
  const regions = (top20Zones ?? [])
    .filter((z) => z && z.lat != null && z.lng != null && z.circle_enabled !== false)
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

  // Set the anchor BEFORE dispatching so the subscriber's movedFar check
  // (which runs on every store change) doesn't see a null anchor and re-enter.
  if (
    activeSort === SORT_OPTIONS.NEAREST &&
    currentLat != null &&
    currentLng != null
  ) {
    lastRefreshAnchor = { lat: currentLat, lng: currentLng };
  } else {
    lastRefreshAnchor = null;
  }

  const top20 = getTop20Zones(allZones, activeSort, currentLat, currentLng);
  store.dispatch(setTop20Zones(top20));
  updateActiveGeofences(top20);
}

let unsubscribeStore = null;

function guardedRecompute() {
  if (isRecomputing) return;
  isRecomputing = true;
  try {
    recomputeAndApply();
  } finally {
    isRecomputing = false;
  }
}

export function startGeofenceManager() {
  if (refreshTimer) return;

  guardedRecompute();

  let prevSort = store.getState().zones.activeSort;
  let prevZonesLength = store.getState().zones.allZones.length;
  let prevStatsKey = JSON.stringify(
    Object.keys(store.getState().zones.stats).sort()
  );

  unsubscribeStore = store.subscribe(() => {
    if (isRecomputing) return;
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
      isRecomputing = true;
      try {
        recomputeAndApply();
      } finally {
        isRecomputing = false;
      }
    }
  });

  refreshTimer = setInterval(guardedRecompute, REFRESH_INTERVAL_MS);
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
  for (const { timerId } of pendingEntries.values()) {
    clearInterval(timerId);
  }
  pendingEntries.clear();
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
