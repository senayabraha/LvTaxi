// ── Passive background location task (top-level definition) ──────────────────
// MUST be defined at module scope and imported from App.jsx so Expo TaskManager
// can deliver background executions even after a headless relaunch.
//
// Role: the slow "is the driver back at work yet?" watcher. It runs while the
// driver is OUTSIDE the work area (PASSIVE_FAR ≈ 20 min, PASSIVE_NEAR ≈ 5 min).
//
//   • Inside work-area polygon  → hand off to ACTIVE tracking (auto-activate).
//   • Outside                   → (re)classify FAR vs NEAR; NO presence heartbeat.
//
// Passive drivers are NEVER counted in zone math and NEVER write driver_presence
// — that is the whole point of "passive". The polygon is the source of truth for
// whether we may auto-activate; we never activate from a native circle.

import * as TaskManager from 'expo-task-manager';
import * as Sentry from '@sentry/react-native';
import { store } from '../../store';
import { setCurrentZone, setStatus } from '../../store/driversSlice';
import { DRIVER_STATUS } from '../constants';
import {
  refreshWorkAreaCache,
  isInsideWorkAreaPolygon,
  classifyPassiveDistance,
  detectStagingZoneFromPoint,
  getWorkAreaPolygonCount,
} from '../workAreaGeometry';
import { maybeSendPresenceHeartbeat } from '../presenceHeartbeat';
import { LVTAXI_PASSIVE_LOCATION_TASK } from './trackingTaskNames';
import { recordTrackingDebug } from './trackingDebug';
import {
  getSessionUserId,
  getLatestLocation,
  persistDriverStatus,
  safeDispatch,
  startActiveTracking,
  startPassiveTracking,
  stopPassiveTracking,
} from './backgroundTrackingService';

TaskManager.defineTask(LVTAXI_PASSIVE_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[passiveLocationTask] task error', error);
    Sentry.captureException(error, {
      tags: { source: 'passiveLocationTask', phase: 'task' },
    });
    return;
  }

  const loc = getLatestLocation(data);
  if (!loc?.coords) return;
  const { latitude: lat, longitude: lng, speed, accuracy, heading } = loc.coords;

  // No session → nothing to track. Stop the passive watch so a logged-out app
  // isn't burning the OS background slot.
  const driverId = await getSessionUserId();
  if (!driverId) {
    await stopPassiveTracking();
    return;
  }

  await refreshWorkAreaCache();
  recordTrackingDebug({
    lastBackgroundLocationAt: Date.now(),
    lastBackgroundLat: lat,
    lastBackgroundLng: lng,
    lastTask: 'passive',
    workAreaPolygonCount: getWorkAreaPolygonCount(),
  });

  if (isInsideWorkAreaPolygon(lat, lng)) {
    // ── Auto-activate ────────────────────────────────────────────────────────
    const zone = detectStagingZoneFromPoint(lat, lng);
    const status = zone ? DRIVER_STATUS.STAGED : DRIVER_STATUS.ACTIVE;

    safeDispatch(setCurrentZone(zone ? zone.id : null));
    await persistDriverStatus(driverId, status, {
      current_zone_id: zone ? zone.id : null,
      work_area_entry_time: new Date().toISOString(),
      work_area_exit_started_at: null,
    });

    // Hand the OS watch over to the active task (active cadence + heartbeat).
    await stopPassiveTracking();
    await startActiveTracking();

    // Force one immediate heartbeat so the driver appears in live data without
    // waiting a full active cycle. (ACTIVE → not counted in a queue; STAGED →
    // counted via STAGING classification.)
    const sent = await maybeSendPresenceHeartbeat({
      driverId,
      zoneId: zone ? zone.id : null,
      classification: zone ? 'STAGING' : 'ACTIVE',
      lat,
      lng,
      speed,
      accuracy,
      heading,
      force: true,
    });

    recordTrackingDebug({
      insideWorkArea: true,
      detectedZoneId: zone ? zone.id : null,
      detectedZoneName: zone ? zone.name : null,
      lastStatus: status,
      lastHeartbeatAt: sent ? Date.now() : undefined,
    });
    return;
  }

  // ── Still outside: reclassify FAR vs NEAR, no heartbeat, not counted ────────
  const mode = classifyPassiveDistance(lat, lng);
  const prev = store.getState().drivers.status;
  if (prev !== mode) {
    await persistDriverStatus(driverId, mode);
    // Restart the passive watch only if the cadence (FAR↔NEAR) actually changed.
    await startPassiveTracking(mode);
  } else {
    safeDispatch(setStatus(mode));
  }

  recordTrackingDebug({
    insideWorkArea: false,
    detectedZoneId: null,
    detectedZoneName: null,
    lastStatus: mode,
  });
});
