import { store } from '../store';
import { setCurrentZone, setStatus, zoneEntered } from '../store/driversSlice';
import { supabase } from './supabase';
import { DRIVER_STATUS } from './constants';
import { recordTrackingDebug } from './backgroundTracking/trackingDebug';
import {
  startActiveTracking,
  startPassiveTracking,
} from './backgroundTracking/backgroundTrackingService';
import { clearDriverPresence } from './zoneStatsEngine';

function safeDispatch(action) {
  try {
    store.dispatch(action);
  } catch (err) {
    console.warn('[driverStatusTransitions] dispatch failed', err);
  }
}

// opts.skipTaskRestart = true  → caller is already running inside the active
// background task. Stopping + restarting the task from within its own execution
// crashes on Android. The task is already running at the right cadence, so skip
// the startActiveTracking call entirely. The status/DB write still happens.
export async function transitionToStaged(driverId, zoneId, opts = {}) {
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

  const patch = {
    status: DRIVER_STATUS.STAGED,
    current_zone_id: zoneId,
    work_area_exit_started_at: null,
    last_seen: opts.lastSeen ?? new Date().toISOString(),
  };

  const { error } = await supabase
    .from('drivers')
    .update(patch)
    .eq('id', driverId);

  if (error) {
    console.warn('[driverStatusTransitions] transitionToStaged failed', error.message);
    return { ok: false, error };
  }

  if (!opts.skipTaskRestart) {
    await ensureActiveTracking('transitionToStaged');
  }
  return { ok: true };
}

export async function transitionToActive(driverId, opts = {}) {
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

  const patch = {
    status: DRIVER_STATUS.ACTIVE,
    current_zone_id: null,
    work_area_exit_started_at: null,
    ...(opts.workAreaEntryTime ? { work_area_entry_time: opts.workAreaEntryTime } : {}),
    last_seen: opts.lastSeen ?? new Date().toISOString(),
  };

  const { error } = await supabase
    .from('drivers')
    .update(patch)
    .eq('id', driverId);

  if (error) {
    console.warn('[driverStatusTransitions] transitionToActive failed', error.message);
    return { ok: false, error };
  }

  if (!opts.skipTaskRestart) {
    await ensureActiveTracking('transitionToActive');
  }
  return { ok: true };
}

export async function transitionToPassive(driverId, status, opts = {}) {
  const nextStatus = status ?? DRIVER_STATUS.PASSIVE_FAR;
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
    const patch = {
      status: nextStatus,
      current_zone_id: null,
      work_area_exit_started_at: null,
      last_seen: opts.lastSeen ?? new Date().toISOString(),
    };
    const { error } = await supabase
      .from('drivers')
      .update(patch)
      .eq('id', driverId);
    if (error) {
      console.warn('[driverStatusTransitions] transitionToPassive failed', error.message);
      return { ok: false, error };
    }
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
