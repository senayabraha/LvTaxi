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
import { DRIVER_STATUS } from '../constants';
import {
  refreshWorkAreaCache,
  isInsideWorkAreaPolygon,
  detectStagingZoneFromPoint,
  getWorkAreaPolygonCount,
} from '../workAreaGeometry';
import { maybeSendPresenceHeartbeat } from '../presenceHeartbeat';
import {
  transitionToActive,
  transitionToStaged,
} from '../driverStatusTransitions';
import { LVTAXI_ACTIVE_LOCATION_TASK } from './trackingTaskNames';
import { recordTrackingDebug } from './trackingDebug';
import {
  getSessionUserId,
  getLatestLocation,
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

  const driverId = await getSessionUserId();
  if (!driverId) {
    await stopActiveTracking();
    return;
  }

  await refreshWorkAreaCache();
  recordTrackingDebug({
    lastBackgroundLocationAt: Date.now(),
    lastBackgroundLat: lat,
    lastBackgroundLng: lng,
    lastTask: 'active',
    workAreaPolygonCount: getWorkAreaPolygonCount(),
  });

  // ── Outside the work area → exit grace (timestamp-based, not counted) ───────
  if (!isInsideWorkAreaPolygon(lat, lng)) {
    await evaluateExitGrace(driverId, { lat, lng });
    return;
  }

  // ── Inside the work area: cancel any in-flight exit grace (re-entry) ────────
  await clearExitGrace(driverId);

  const zone = detectStagingZoneFromPoint(lat, lng);
  const desiredZone = zone ? zone.id : null;

  // Centralized transition: sets status + zone atomically in Redux and only
  // writes the drivers row on a real status/zone change (not every 5s fix).
  if (zone) {
    await transitionToStaged(driverId, zone.id);
  } else {
    await transitionToActive(driverId);
  }

  // Throttled (~25s) heartbeat. STAGED carries zone_id (counted); ACTIVE sends a
  // null zone (participating but never counted toward a specific staging queue).
  const sent = await maybeSendPresenceHeartbeat({
    driverId,
    zoneId: desiredZone,
    classification: zone ? 'STAGING' : 'ACTIVE',
    lat,
    lng,
    speed,
    accuracy,
    heading,
  });

  recordTrackingDebug({
    insideWorkArea: true,
    detectedZoneId: desiredZone,
    detectedZoneName: zone ? zone.name : null,
    lastStatus: zone ? DRIVER_STATUS.STAGED : DRIVER_STATUS.ACTIVE,
    lastHeartbeatAt: sent ? Date.now() : undefined,
  });
});
