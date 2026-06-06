// ── Exit-grace manager (timestamp-based) ─────────────────────────────────────
// When an ACTIVE/STAGED driver leaves the work-area polygon we don't immediately
// drop them to passive — that would make staging counts flap on a brief GPS
// drift or a quick loop off-property. Instead we record work_area_exit_started_at
// and evaluate the elapsed time on every subsequent background fix.
//
// Why timestamp, not setTimeout: a background task may be suspended/relaunched by
// the OS, so a JS timer is unreliable. Comparing now() against a persisted
// timestamp survives suspension and headless relaunch. Supabase holds the
// timestamp as the cross-launch source of truth.
//
// During EXIT_GRACE the driver is NOT counted in any staging-zone math: we clear
// their presence row immediately so the live count drops them without waiting for
// the 90s TTL. The light GPS task keeps running only to detect re-entry.

import { store } from '../../store';
import {
  setStatus,
  setWorkAreaExitStartedAt,
  clearWorkAreaExitStartedAt,
  setCurrentZone,
} from '../../store/driversSlice';
import { DRIVER_STATUS, WORK_AREA_EXIT_GRACE_MS } from '../constants';
import { supabase } from '../supabase';
import { clearDriverPresence } from '../zoneStatsEngine';
import { classifyPassiveDistance } from '../workAreaGeometry';
import { recordTrackingDebug } from './trackingDebug';
import {
  persistDriverStatus,
  startPassiveTracking,
  startExitGraceTracking,
  stopActiveTracking,
} from './backgroundTrackingService';

// Resolve the exit-grace start timestamp (ms). Prefers the (possibly cold) store,
// then falls back to Supabase, which is authoritative across launches.
async function getExitStartedAt(driverId) {
  const local = store.getState().drivers.workAreaExitStartedAt;
  if (local) return new Date(local).getTime();
  if (!driverId) return null;
  const { data, error } = await supabase
    .from('drivers')
    .select('work_area_exit_started_at')
    .eq('id', driverId)
    .maybeSingle();
  if (error) {
    console.warn('[exitGraceManager] read exit start failed', error.message);
    return null;
  }
  const ts = data?.work_area_exit_started_at;
  return ts ? new Date(ts).getTime() : null;
}

// Begin the grace period: stamp the start time, drop out of staging math now, and
// switch the GPS task to the lighter exit-grace cadence.
export async function startExitGrace(driverId, latestLocation) {
  const startedIso = new Date().toISOString();
  store.dispatch(setWorkAreaExitStartedAt(Date.now()));
  store.dispatch(setCurrentZone(null));
  store.dispatch(setStatus(DRIVER_STATUS.EXIT_GRACE));

  await persistDriverStatus(driverId, DRIVER_STATUS.EXIT_GRACE, {
    work_area_exit_started_at: startedIso,
    current_zone_id: null,
  });

  // Not counted while in grace — clear immediately rather than waiting for TTL.
  if (driverId) await clearDriverPresence(driverId);

  await startExitGraceTracking();
  recordTrackingDebug({
    lastStatus: DRIVER_STATUS.EXIT_GRACE,
    insideWorkArea: false,
    workAreaExitStartedAt: Date.now(),
    detectedZoneId: null,
    detectedZoneName: null,
    lastTaskDesiredStatus: DRIVER_STATUS.EXIT_GRACE,
    lastTaskStatusAfter: store.getState().drivers.status,
  });
}

// Called on every background fix while the driver is OUTSIDE the work area.
// Starts grace if not started, otherwise checks whether 30 minutes have elapsed.
export async function evaluateExitGrace(driverId, latestLocation) {
  const startedAt = await getExitStartedAt(driverId);
  if (!startedAt) {
    await startExitGrace(driverId, latestLocation);
    return DRIVER_STATUS.EXIT_GRACE;
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed >= WORK_AREA_EXIT_GRACE_MS) {
    await completeExitToPassive(driverId, latestLocation);
    return store.getState().drivers.status;
  }

  // Still within the grace window — keep EXIT_GRACE + light tracking.
  store.dispatch(setStatus(DRIVER_STATUS.EXIT_GRACE));
  await startExitGraceTracking();
  recordTrackingDebug({
    lastStatus: DRIVER_STATUS.EXIT_GRACE,
    insideWorkArea: false,
    workAreaExitStartedAt: startedAt,
    lastTaskDesiredStatus: DRIVER_STATUS.EXIT_GRACE,
    lastTaskStatusAfter: store.getState().drivers.status,
  });
  return DRIVER_STATUS.EXIT_GRACE;
}

// Driver re-entered the work area within the grace window: cancel the grace.
export async function clearExitGrace(driverId) {
  if (!store.getState().drivers.workAreaExitStartedAt) return;
  store.dispatch(clearWorkAreaExitStartedAt());
  if (driverId) {
    const { error } = await supabase
      .from('drivers')
      .update({ work_area_exit_started_at: null })
      .eq('id', driverId);
    if (error) {
      console.warn('[exitGraceManager] clear exit start failed', error.message);
    }
  }
  recordTrackingDebug({ workAreaExitStartedAt: null });
}

// Grace expired (>= 30 min outside): clear presence, drop to passive, swap tasks.
export async function completeExitToPassive(driverId, latestLocation) {
  const lat = latestLocation?.lat ?? latestLocation?.coords?.latitude ?? null;
  const lng = latestLocation?.lng ?? latestLocation?.coords?.longitude ?? null;
  const mode =
    lat != null && lng != null
      ? classifyPassiveDistance(lat, lng)
      : DRIVER_STATUS.PASSIVE_FAR;

  if (driverId) await clearDriverPresence(driverId);
  store.dispatch(clearWorkAreaExitStartedAt());
  store.dispatch(setCurrentZone(null));
  store.dispatch(setStatus(mode));

  await persistDriverStatus(driverId, mode, {
    work_area_exit_started_at: null,
    work_area_exit_time: new Date().toISOString(),
    current_zone_id: null,
  });

  await stopActiveTracking();
  await startPassiveTracking(mode);

  recordTrackingDebug({
    lastStatus: mode,
    insideWorkArea: false,
    workAreaExitStartedAt: null,
    detectedZoneId: null,
    detectedZoneName: null,
    lastTaskDesiredStatus: mode,
    lastTaskStatusAfter: store.getState().drivers.status,
  });
  return mode;
}
