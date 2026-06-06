// ── Active background location task (top-level definition) ───────────────────
// MUST be defined at module scope and imported from App.jsx (Expo requirement).
//
// Role: the fast watcher that runs while the driver is participating — inside the
// work area (ACTIVE), in a staging zone (STAGED), or just-left (EXIT_GRACE). It
// drives the live presence heartbeat and the automatic state transitions.
//
//   • Inside a staging-zone polygon → STAGED, zone_id set, STAGING heartbeat
//                                     (this is the ONLY case counted in a queue).
//   • Inside work area, no zone      → ACTIVE, zone_id null, ACTIVE heartbeat
//                                     (participating but not in any queue).
//   • Outside the work area          → hand to the timestamp-based exit-grace
//                                     manager (30-min grace, not counted).
//
// Polygon position is the source of truth. We do NOT write every GPS point to
// Supabase: the drivers row is only updated when the status/zone actually
// changes, and the presence heartbeat stays throttled to ~25s.

import * as TaskManager from 'expo-task-manager';
import * as Sentry from '@sentry/react-native';
import { store } from '../../store';
import { setStatus } from '../../store/driversSlice';
import { DRIVER_STATUS } from '../constants';
import {
  refreshWorkAreaCache,
  isInsideWorkAreaPolygon,
  detectStagingZoneFromPoint,
  getWorkAreaPolygonCount,
} from '../workAreaGeometry';
import { maybeSendPresenceHeartbeat } from '../presenceHeartbeat';
import { transitionToActive, transitionToStaged } from '../driverStatusTransitions';
import { LVTAXI_ACTIVE_LOCATION_TASK } from './trackingTaskNames';
import { recordTrackingDebug } from './trackingDebug';
import {
  getSessionUserId,
  getLatestLocation,
  safeDispatch,
  stopActiveTracking,
} from './backgroundTrackingService';
import { evaluateExitGrace, clearExitGrace } from './exitGraceManager';

TaskManager.defineTask(LVTAXI_ACTIVE_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[activeLocationTask] task error', error);
    Sentry.captureException(error, {
      tags: { source: 'activeLocationTask', phase: 'task' },
    });
    return;
  }

  const loc = getLatestLocation(data);
  if (!loc?.coords) return;
  const { latitude: lat, longitude: lng, speed, accuracy, heading } = loc.coords;
  const statusBefore = store.getState().drivers.status;

  const driverId = await getSessionUserId();
  if (!driverId) {
    await stopActiveTracking();
    return;
  }

  await refreshWorkAreaCache();
  recordTrackingDebug({
    lastBackgroundLocationAt: Date.now(),
    lastActiveTaskRunAt: Date.now(),
    lastBackgroundLat: lat,
    lastBackgroundLng: lng,
    lastTask: 'active',
    lastTaskStatusBefore: statusBefore,
    workAreaPolygonCount: getWorkAreaPolygonCount(),
  });

  const insideWorkArea = isInsideWorkAreaPolygon(lat, lng);
  const zone = detectStagingZoneFromPoint(lat, lng);

  if (zone) {
    const reason = insideWorkArea
      ? 'staging_zone_detected_inside_work_area'
      : 'staging_zone_overrode_work_area_outside';
    const desiredStatus = DRIVER_STATUS.STAGED;
    recordTrackingDebug({
      insideWorkArea,
      detectedZoneId: zone.id,
      detectedZoneName: zone.name,
      lastTaskDesiredStatus: desiredStatus,
      lastTaskDecisionReason: reason,
    });

    await clearExitGrace(driverId);
    const current = store.getState().drivers;
    const needsTransition =
      current.status !== DRIVER_STATUS.STAGED ||
      current.currentZoneId !== zone.id ||
      !current.isInsideZone;
    if (needsTransition) {
      await transitionToStaged(driverId, zone.id, {
        source: 'activeLocationTask',
      });
    }

    const sent = await maybeSendPresenceHeartbeat({
      driverId,
      zoneId: zone.id,
      classification: 'STAGING',
      lat,
      lng,
      speed,
      accuracy,
      heading,
    });

    recordTrackingDebug({
      insideWorkArea,
      detectedZoneId: zone.id,
      detectedZoneName: zone.name,
      lastStatus: desiredStatus,
      lastTaskStatusAfter: store.getState().drivers.status,
      lastTaskDecisionReason: reason,
      ...(sent ? { lastHeartbeatAt: Date.now() } : {}),
    });
    return;
  }

  // ── Outside the work area → exit grace (timestamp-based, not counted) ───────
  if (!insideWorkArea) {
    recordTrackingDebug({
      insideWorkArea: false,
      detectedZoneId: null,
      detectedZoneName: null,
      lastTaskDesiredStatus: DRIVER_STATUS.EXIT_GRACE,
      lastTaskDecisionReason: 'outside_work_area_no_staging_zone',
    });
    await evaluateExitGrace(driverId, { lat, lng });
    return;
  }

  // ── Inside the work area: cancel any in-flight exit grace (re-entry) ────────
  await clearExitGrace(driverId);

  const desiredStatus = DRIVER_STATUS.ACTIVE;
  const desiredZone = null;
  recordTrackingDebug({
    insideWorkArea: true,
    detectedZoneId: desiredZone,
    detectedZoneName: null,
    lastTaskDesiredStatus: desiredStatus,
    lastTaskDecisionReason: 'inside_work_area_no_staging_zone',
  });

  const prevStatus = store.getState().drivers.status;
  const prevZone = store.getState().drivers.currentZoneId ?? null;
  const changed = prevStatus !== desiredStatus || prevZone !== desiredZone;

  if (changed) {
    // Only touch the drivers row on a real transition — not every 5s fix.
    await transitionToActive(driverId, {
      source: 'activeLocationTask',
    });
  } else {
    // Keep Redux in sync without a Supabase write.
    safeDispatch(setStatus(desiredStatus));
  }

  // Throttled (~25s) heartbeat. STAGED carries zone_id (counted); ACTIVE sends a
  // null zone (participating but never counted toward a specific staging queue).
  const sent = await maybeSendPresenceHeartbeat({
    driverId,
    zoneId: desiredZone,
    classification: 'ACTIVE',
    lat,
    lng,
    speed,
    accuracy,
    heading,
  });

  recordTrackingDebug({
    insideWorkArea: true,
    detectedZoneId: desiredZone,
    detectedZoneName: null,
    lastStatus: desiredStatus,
    lastTaskStatusAfter: store.getState().drivers.status,
    lastTaskDecisionReason: 'inside_work_area_no_staging_zone',
    ...(sent ? { lastHeartbeatAt: Date.now() } : {}),
  });
});
