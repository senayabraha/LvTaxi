import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Sentry from '@sentry/react-native';
import { store } from '../store';
import { zoneExited } from '../store/driversSlice';
import { setTop20Zones } from '../store/zonesSlice';
import { supabase } from './supabase';
import { getDistanceMeters } from './locationEngine';
import { stopRecording } from './trajectoryRecorder';
import { processZoneExit } from './visitProcessor';
import { enterStagingZone } from './stagingService';
import { clearDriverPresence } from './zoneStatsEngine';
import { recordTrackingDebug } from './backgroundTracking/trackingDebug';
import { confirmStagingLocation } from './polygonConfirmation';
import { DRIVER_STATUS } from './constants';

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

function zoneDebugBase(zoneId, zone, extra = {}) {
  return {
    geofenceEventAt: Date.now(),
    geofenceZoneId: zoneId,
    geofenceZoneName: zone?.name ?? null,
    ...extra,
  };
}

async function getHeartbeatPoint() {
  const drivers = store.getState().drivers;
  if (drivers.currentLat != null && drivers.currentLng != null) {
    return {
      lat: drivers.currentLat,
      lng: drivers.currentLng,
      speed: drivers.speed,
      accuracy: drivers.rawAccuracy,
      heading: drivers.heading,
      mocked: drivers.mocked === true,
    };
  }

  try {
    const pos = await Location.getLastKnownPositionAsync({ maxAge: 30_000 });
    if (pos?.coords) {
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        speed: pos.coords.speed,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
        mocked: pos.mocked === true,
      };
    }
  } catch (err) {
    console.warn('[geofenceEngine] heartbeat location lookup failed', err);
  }

  return null;
}

function getZoneById(id) {
  if (activeZoneById.has(id)) return activeZoneById.get(id);
  const all = store.getState().zones.allZones;
  return all.find((z) => z.id === id) ?? null;
}

// Hybrid layer: native circle wakes us up, polygon refines. Delegates to the
// shared confirmation helper so the manual ("I'm Staging") path and this geofence
// path use one implementation.
//   • No polygon  → tight radius fallback from confirmStagingLocation.
//   • Has polygon → must contain the point; a malformed-polygon error is
//                   fail-closed so we never confirm staging on corrupt data.
export function verifyWithPolygon(zone, lat, lng) {
  return confirmStagingLocation(zone, lat, lng).confirmed;
}

async function completeHandleEnter(zoneId, zone, driverId) {
  // Set sentinel BEFORE any async work so the handleEnter guard keeps re-fires
  // out even while the staging service is in flight.
  activeVisits.set(zoneId, null);
  recordTrackingDebug(
    zoneDebugBase(zoneId, zone, { geofenceLastEvent: 'geofence_polygon_confirmed' })
  );

  // Resolve a position for the forced heartbeat before handing off to the
  // staging service (which sends it internally).
  const point = await getHeartbeatPoint();

  // enterStagingZone: transition + reset throttle + start recording + forced heartbeat.
  const result = await enterStagingZone({
    driverId,
    zoneId,
    zone,
    source: 'geofenceEngine.completeHandleEnter',
    lat:      point?.lat  ?? null,
    lng:      point?.lng  ?? null,
    speed:    point?.speed ?? null,
    accuracy: point?.accuracy ?? null,
    heading:  point?.heading ?? null,
    mocked:   point?.mocked ?? false,
  });
  const visitId = result.visitId ?? null;
  if (visitId) activeVisits.set(zoneId, visitId);

  recordTrackingDebug(
    zoneDebugBase(zoneId, zone, {
      geofenceLastEvent: 'geofence_promoted_to_staged',
      geofenceVisitId: visitId,
      geofenceTransitionOk: result.ok,
      geofenceHeartbeatSent: result.heartbeatSent,
      lastStatus: DRIVER_STATUS.STAGED,
      detectedZoneId: zoneId,
      detectedZoneName: zone?.name ?? null,
      workAreaExitStartedAt: null,
      ...(result.heartbeatSent ? { lastHeartbeatAt: Date.now() } : {}),
    })
  );
}

async function handleEnter(zoneId) {
  const zone = getZoneById(zoneId);
  const driverId = store.getState().auth.session?.user?.id ?? null;
  recordTrackingDebug(
    zoneDebugBase(zoneId, zone, { geofenceLastEvent: 'geofence_enter_received' })
  );

  // Guard against Expo re-firing Enter or a polygon-retry racing with a fresh Enter.
  // activeVisits is set inside completeHandleEnter and cleared on exit; pendingEntries
  // is set while the polygon retry loop is running.
  if (activeVisits.has(zoneId) || pendingEntries.has(zoneId)) return;

  // Native geofence is wider than the actual lane. Confirm with the shared
  // staging helper so malformed polygons fail closed and polygon-less zones use
  // the same tight radius fallback as the manual path.
  if (zone) {
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

  // Clear presence immediately on confirmed exit, regardless of whether a
  // visitId is available. A driver staged via the active-task path (no geofence
  // visit) would otherwise stay counted until the 90s TTL expires (LIFE-6).
  if (driverId) {
    try {
      await clearDriverPresence(driverId);
    } catch (err) {
      console.warn('[geofenceEngine] clearPresence on exit failed', err);
    }
  }

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

export function getTop20Zones(allZones, _sortOption, driverLat, driverLng) {
  if (!allZones || allZones.length === 0) return [];
  // Geofence slots are for physical proximity only. The visible list may sort
  // by flow or wait, but native monitoring must always track the nearest zones.
  const list = allZones.filter((z) => !z.is_coming_soon);

  if (driverLat == null || driverLng == null) {
    return list.slice(0, 20);
  }
  list.sort((a, b) => {
    const da = getDistanceMeters(driverLat, driverLng, a.lat, a.lng);
    const db = getDistanceMeters(driverLat, driverLng, b.lat, b.lng);
    return da - db;
  });

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

// Allow external callers (e.g. ImStagingButton) to register a manually-opened
// visit so handleExit can find the visitId and process the zone exit correctly.
export function registerActiveVisit(zoneId, visitId) {
  activeVisits.set(zoneId, visitId);
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
  const { currentLat, currentLng } = state.drivers;

  // Set the anchor BEFORE dispatching so the subscriber's movedFar check
  // (which runs on every store change) doesn't see a null anchor and re-enter.
  if (currentLat != null && currentLng != null) {
    lastRefreshAnchor = { lat: currentLat, lng: currentLng };
  } else {
    lastRefreshAnchor = null;
  }

  const top20 = getTop20Zones(allZones, null, currentLat, currentLng);
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

  let prevZonesLength = store.getState().zones.allZones.length;

  unsubscribeStore = store.subscribe(() => {
    if (isRecomputing) return;
    const state = store.getState();
    const { allZones } = state.zones;
    const { currentLat, currentLng } = state.drivers;

    const zonesChanged = allZones.length !== prevZonesLength;

    let movedFar = false;
    if (
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
      !lastRefreshAnchor &&
      currentLat != null &&
      currentLng != null
    ) {
      movedFar = true;
    }

    if (zonesChanged || movedFar) {
      prevZonesLength = allZones.length;
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
