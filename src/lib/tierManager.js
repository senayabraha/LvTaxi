// ── Tier manager — GPS cadence only ──────────────────────────────────────────
// Manages the FOREGROUND location engine's power mode based on the driver status
// that is authoritatively set by the background tasks.
//
// This module does NOT: detect polygons, write to the drivers table, or run
// exit-grace timers. All status/zone/entry/exit writes are owned by the
// background task path (activeLocationTask → transitionDriverState /
// exitGraceManager). Racing those writes caused work_area_entry_time /
// work_area_exit_time column clobbering (LIFE-1).
//
//   Tier 1: HIGH  / 1 s   — driver is STAGED in a zone
//   Tier 2: LOW   / 5 s   — ACTIVE or EXIT_GRACE or PASSIVE_NEAR (in / near work area)
//   Tier 3: PASSIVE / 20 m — PASSIVE_FAR, TRACKING_DISABLED, or unknown

import { store } from '../store';
import { setGpsTier } from '../store/driversSlice';
import {
  startLocationTracking,
  stopLocationTracking,
  setGPSMode,
  GPS_MODE,
} from './locationEngine';
import { DRIVER_STATUS } from './constants';

export const TIER = { ONE: 1, TWO: 2, THREE: 3 };

export const TIER_CONFIG = {
  [TIER.ONE]:   { mode: GPS_MODE.HIGH,    intervalMs: 1000,      label: '1s' },
  [TIER.TWO]:   { mode: GPS_MODE.LOW,     intervalMs: 5000,      label: '5s' },
  [TIER.THREE]: { mode: GPS_MODE.PASSIVE, intervalMs: 1_200_000, label: '20m' },
};

let currentTier = TIER.THREE;
let unsubStore = null;
let started = false;

export function getCurrentTier() {
  return currentTier;
}

// Map the status set by background tasks to a GPS power tier.
export function statusToTier(status) {
  if (status === DRIVER_STATUS.STAGED) return TIER.ONE;
  if (
    status === DRIVER_STATUS.ACTIVE ||
    status === DRIVER_STATUS.EXIT_GRACE ||
    status === DRIVER_STATUS.PASSIVE_NEAR
  ) return TIER.TWO;
  return TIER.THREE;
}

async function applyTier(tier) {
  if (currentTier === tier) return;
  currentTier = tier;
  store.dispatch(setGpsTier(tier));
  const cfg = TIER_CONFIG[tier];
  if (!cfg) return;
  try {
    await setGPSMode(cfg.mode);
  } catch (err) {
    console.warn('[tierManager] setGPSMode failed, restarting tracking', err);
    try {
      stopLocationTracking();
      await startLocationTracking(cfg.mode);
    } catch (err2) {
      console.warn('[tierManager] restart failed', err2);
    }
  }
}

export async function startTierManager() {
  if (started) return;
  started = true;

  // Boot the foreground location watcher at the passive cadence. The subscriber
  // below will upgrade it once the background task reports a status.
  try {
    await startLocationTracking(TIER_CONFIG[TIER.THREE].mode);
  } catch (err) {
    console.warn('[tierManager] startLocationTracking failed', err);
  }

  // Apply the tier for whatever status the store already holds.
  let prevStatus = store.getState().drivers.status;
  const initialTier = statusToTier(prevStatus);
  if (initialTier !== currentTier) {
    currentTier = initialTier;
    store.dispatch(setGpsTier(initialTier));
    // GPS mode was just set to PASSIVE by startLocationTracking above; only
    // upgrade now if we already know we're staged or active.
    if (initialTier < TIER.THREE) {
      applyTier(initialTier).catch((err) =>
        console.warn('[tierManager] initial applyTier failed', err)
      );
    }
  }

  // React to status changes driven by background tasks.
  unsubStore = store.subscribe(() => {
    const newStatus = store.getState().drivers.status;
    if (newStatus !== prevStatus) {
      prevStatus = newStatus;
      applyTier(statusToTier(newStatus)).catch((err) =>
        console.warn('[tierManager] applyTier failed', err)
      );
    }
  });
}

export async function stopTierManager() {
  if (!started) return;
  started = false;
  if (unsubStore) {
    unsubStore();
    unsubStore = null;
  }
  currentTier = TIER.THREE;
}
