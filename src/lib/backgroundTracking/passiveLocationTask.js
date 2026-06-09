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
import { DRIVER_STATUS } from '../constants';
import {
  refreshWorkAreaCache,
  isInsideWorkAreaPolygon,
  classifyPassiveDistance,
  detectStagingZoneFromPoint,
  getWorkAreaPolygonCount,
} from '../workAreaGeometry';
import {
  transitionToActive,
  transitionToPassive,
} from '../driverStatusTransitions';
import { enterStagingZone } from '../stagingService';
import { maybeSendPresenceHeartbeat } from '../presenceHeartbeat';
import { LVTAXI_PASSIVE_LOCATION_TASK } from './trackingTaskNames';
import { recordTrackingDebug } from './trackingDebug';
import {
  getSessionUserId,
  getLatestLocation,
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
  const statusBefore = store.getState().drivers.status;

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
    lastPassiveTaskRunAt: Date.now(),
    lastBackgroundLat: lat,
    lastBackgroundLng: lng,
    lastTask: 'passive',
    lastTaskStatusBefore: statusBefore,
    workAreaPolygonCount: getWorkAreaPolygonCount(),
  });

  const insideWorkArea = isInsideWorkAreaPolygon(lat, lng);
  const zone = detectStagingZoneFromPoint(lat, lng);

  if (zone) {
    const reason = insideWorkArea
      ? 'staging_zone_detected_inside_work_area'
      : 'staging_zone_overrode_work_area_outside';
    const status = DRIVER_STATUS.STAGED;
    recordTrackingDebug({
      insideWorkArea,
      detectedZoneId: zone.id,
      detectedZoneName: zone.name,
      lastTaskDesiredStatus: status,
      lastTaskDecisionReason: reason,
    });

    // enterStagingZone: transition + reset heartbeat throttle + start recording
    // + forced presence write. Passive → staged must force a heartbeat so the
    // driver appears in live counts immediately (CNT-1/CNT-2, Issue 7).
    const stagingResult = await enterStagingZone({
      driverId,
      zoneId: zone.id,
      zone,
      source: 'passiveLocationTask',
      lat, lng, speed, accuracy, heading,
    });

    recordTrackingDebug({
      insideWorkArea,
      detectedZoneId: zone.id,
      detectedZoneName: zone.name,
      lastStatus: status,
      lastTaskStatusAfter: store.getState().drivers.status,
      lastTaskDecisionReason: reason,
      ...(stagingResult.heartbeatSent ? { lastHeartbeatAt: Date.now() } : {}),
    });
    return;
  }

  if (insideWorkArea) {
    // ── Auto-activate ────────────────────────────────────────────────────────
    const status = DRIVER_STATUS.ACTIVE;
    recordTrackingDebug({
      insideWorkArea: true,
      detectedZoneId: null,
      detectedZoneName: null,
      lastTaskDesiredStatus: status,
      lastTaskDecisionReason: 'inside_work_area_no_staging_zone',
    });

    await transitionToActive(driverId, {
      source: 'passiveLocationTask',
      workAreaEntryTime: new Date().toISOString(),
    });

    // Force one immediate heartbeat so the driver appears in live data without
    // waiting a full active cycle. (ACTIVE → not counted in a queue; STAGED →
    // counted via STAGING classification.)
    const sent = await maybeSendPresenceHeartbeat({
      driverId,
      zoneId: null,
      classification: 'ACTIVE',
      lat,
      lng,
      speed,
      accuracy,
      heading,
      force: true,
    });

    recordTrackingDebug({
      insideWorkArea: true,
      detectedZoneId: null,
      detectedZoneName: null,
      lastStatus: status,
      lastTaskStatusAfter: store.getState().drivers.status,
      ...(sent ? { lastHeartbeatAt: Date.now() } : {}),
    });
    return;
  }

  // ── Still outside: reclassify FAR vs NEAR, no heartbeat, not counted ────────
  const mode = classifyPassiveDistance(lat, lng);
  const prev = store.getState().drivers.status;
  recordTrackingDebug({
    lastTaskDesiredStatus: mode,
    lastTaskStatusBefore: prev,
    lastTaskDecisionReason: 'outside_work_area_no_staging_zone',
  });
  await transitionToPassive(driverId, mode, {
    source: 'passiveLocationTask',
    clearPresence: false,
  });

  recordTrackingDebug({
    insideWorkArea: false,
    detectedZoneId: null,
    detectedZoneName: null,
    lastStatus: mode,
    lastTaskStatusAfter: store.getState().drivers.status,
    lastTaskDecisionReason: 'outside_work_area_no_staging_zone',
  });
});
