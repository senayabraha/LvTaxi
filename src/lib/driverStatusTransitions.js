import { store } from '../store';
import { setStatus, zoneEntered } from '../store/driversSlice';
import { supabase } from './supabase';
import { DRIVER_STATUS } from './constants';

function safeDispatch(action) {
  try {
    store.dispatch(action);
  } catch (err) {
    console.warn('[driverStatusTransitions] dispatch failed', err);
  }
}

export async function transitionToStaged(driverId, zoneId, opts = {}) {
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

  return { ok: true };
}
