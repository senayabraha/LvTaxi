import { store } from '../store';
import { setCurrentZone, setStatus, zoneEntered } from '../store/driversSlice';
import { supabase } from './supabase';
import { DRIVER_STATUS } from './constants';
import { recordTrackingDebug } from './backgroundTracking/trackingDebug';
import {
  startActiveTracking,
  startPassiveTracking,
} from './backgroundTracking/backgroundTrackingService';
import { clearDriverPresence, ensureOpenVisit } from './zoneStatsEngine';

function safeDispatch(action) {
  try {
    store.dispatch(action);
  } catch (err) {
    console.warn('[driverStatusTransitions] dispatch failed', err);
  }
}

// Single source of truth for all driver-status DB writes.
// Writes the drivers row and emits one audit row to driver_status_events (migration 025).
// Redux dispatch is left to the caller since different transitions use different actions
// (zoneEntered vs setCurrentZone) — this function owns only the persistence layer.
//
// patch: extra columns to merge into the drivers update (e.g. work_area_exit_started_at,
//        work_area_entry_time). The default base sets work_area_exit_started_at = null
//        which callers override via patch when they need to preserve it.
export async function transitionDriverState({
  driverId,
  fromStatus = null,
  toStatus,
  fromZoneId = null,
  toZoneId = null,
  lat = null,
  lng = null,
  accuracy = null,
  source = 'unknown',
  reason = null,
  patch = {},
  lastSeen = null,
} = {}) {
  if (!driverId) return { ok: false, error: 'missing_driver_id' };

  // Fire-and-forget audit insert — never blocks the transition on audit failure.
  supabase
    .from('driver_status_events')
    .insert({
      driver_id:    driverId,
      from_status:  fromStatus ?? null,
      to_status:    toStatus,
      from_zone_id: fromZoneId ?? null,
      to_zone_id:   toZoneId ?? null,
      lat:          lat ?? null,
      lng:          lng ?? null,
      accuracy:     accuracy ?? null,
      source,
      reason:       reason ?? null,
    })
    .then(({ error: auditErr }) => {
      if (auditErr) {
        console.warn('[driverStatusTransitions] audit insert failed', auditErr.message);
      }
    });

  // patch wins over the defaults for any key it provides (e.g. work_area_exit_started_at).
  const dbPatch = {
    status:                    toStatus,
    current_zone_id:           toZoneId ?? null,
    work_area_exit_started_at: null,
    last_seen:                 lastSeen ?? new Date().toISOString(),
    ...patch,
  };

  const { error } = await supabase.from('drivers').update(dbPatch).eq('id', driverId);
  if (error) {
    console.warn('[driverStatusTransitions] transitionDriverState DB write failed', error.message);
    return { ok: false, error };
  }
  return { ok: true };
}

// opts.skipTaskRestart = true  → caller is already running inside the active
// background task. Stopping + restarting the task from within its own execution
// crashes on Android. The task is already running at the right cadence, so skip
// the startActiveTracking call entirely. The status/DB write still happens.
export async function transitionToStaged(driverId, zoneId, opts = {}) {
  const fromStatus  = store.getState().drivers.status;
  const fromZoneId  = store.getState().drivers.currentZoneId ?? null;

  const payload = {
    status: DRIVER_STATUS.STAGED,
    currentZoneId: zoneId,
    isInsideZone: true,
  };
  recordTrackingDebug({
    lastTransitionSource: opts.source ?? 'transitionToStaged',
    lastTransitionPayload: payload,
  });

  safeDispatch(zoneEntered(zoneId));
  safeDispatch(setStatus(DRIVER_STATUS.STAGED));

  if (!driverId) {
    return { ok: false, error: 'missing_driver_id' };
  }

  const result = await transitionDriverState({
    driverId,
    fromStatus,
    toStatus:    DRIVER_STATUS.STAGED,
    fromZoneId,
    toZoneId:    zoneId,
    source:      opts.source ?? 'transitionToStaged',
    lastSeen:    opts.lastSeen ?? new Date().toISOString(),
  });
  if (!result.ok) return result;

  // Single source of truth for the visit: ensure exactly one OPEN zone_visits row
  // for this driver, regardless of which detector (geofence / poll / manual)
  // triggered the staging. Both other callers now consume the returned visitId
  // instead of inserting their own row (Issue 4 / CNT-1, CNT-2, CNT-5).
  const { visitId } = await ensureOpenVisit(driverId, zoneId);

  if (!opts.skipTaskRestart) {
    await ensureActiveTracking('transitionToStaged');
  }
  return { ok: true, visitId };
}

export async function transitionToActive(driverId, opts = {}) {
  const fromStatus = store.getState().drivers.status;
  const fromZoneId = store.getState().drivers.currentZoneId ?? null;

  const payload = {
    status: DRIVER_STATUS.ACTIVE,
    currentZoneId: null,
    isInsideZone: false,
  };
  recordTrackingDebug({
    lastTransitionSource: opts.source ?? 'transitionToActive',
    lastTransitionPayload: payload,
  });

  safeDispatch(setCurrentZone(null));
  safeDispatch(setStatus(DRIVER_STATUS.ACTIVE));

  if (!driverId) {
    return { ok: false, error: 'missing_driver_id' };
  }

  const extraPatch = opts.workAreaEntryTime
    ? { work_area_entry_time: opts.workAreaEntryTime }
    : {};

  const result = await transitionDriverState({
    driverId,
    fromStatus,
    toStatus:  DRIVER_STATUS.ACTIVE,
    fromZoneId,
    toZoneId:  null,
    source:    opts.source ?? 'transitionToActive',
    lastSeen:  opts.lastSeen ?? new Date().toISOString(),
    patch:     extraPatch,
  });
  if (!result.ok) return result;

  if (!opts.skipTaskRestart) {
    await ensureActiveTracking('transitionToActive');
  }
  return { ok: true };
}

export async function transitionToPassive(driverId, status, opts = {}) {
  const nextStatus = status ?? DRIVER_STATUS.PASSIVE_FAR;
  const fromStatus = store.getState().drivers.status;
  const fromZoneId = store.getState().drivers.currentZoneId ?? null;

  const payload = {
    status: nextStatus,
    currentZoneId: null,
    isInsideZone: false,
  };
  recordTrackingDebug({
    lastTransitionSource: opts.source ?? 'transitionToPassive',
    lastTransitionPayload: payload,
  });

  safeDispatch(setCurrentZone(null));
  safeDispatch(setStatus(nextStatus));

  if (driverId && opts.clearPresence !== false) {
    await clearDriverPresence(driverId);
  }

  if (driverId) {
    const result = await transitionDriverState({
      driverId,
      fromStatus,
      toStatus:  nextStatus,
      fromZoneId,
      toZoneId:  null,
      source:    opts.source ?? 'transitionToPassive',
      lastSeen:  opts.lastSeen ?? new Date().toISOString(),
    });
    if (!result.ok) return result;
  }

  await ensurePassiveTracking(nextStatus, 'transitionToPassive');
  return { ok: true };
}

async function ensureActiveTracking(source) {
  recordTrackingDebug({
    requestedTrackingMode: 'active',
    activeTaskStartRequestedAt: Date.now(),
    passiveTaskStopRequestedAt: Date.now(),
    activeTaskStartError: null,
    passiveTaskStopError: null,
  });
  const ok = await startActiveTracking();
  recordTrackingDebug({
    trackingModeAfterTransition: ok ? 'active' : 'active_start_failed',
    activeTaskStartError: ok ? null : `${source}_start_active_failed`,
  });
}

async function ensurePassiveTracking(status, source) {
  recordTrackingDebug({
    requestedTrackingMode: 'passive',
    passiveTaskStartRequestedAt: Date.now(),
    passiveTaskStartError: null,
    activeTaskStopError: null,
  });
  const ok = await startPassiveTracking(status);
  recordTrackingDebug({
    trackingModeAfterTransition: ok ? 'passive' : 'passive_start_failed',
    passiveTaskStartError: ok ? null : `${source}_start_passive_failed`,
  });
}
