// ── Background tracking service ──────────────────────────────────────────────
// Owns the lifecycle of the two real background location tasks
// (Location.startLocationUpdatesAsync). The tasks themselves are defined at
// module scope in passiveLocationTask.js / activeLocationTask.js; this layer only
// starts/stops/reconfigures them and persists status.
//
// Mechanism note (app-store honesty): startLocationUpdatesAsync keeps delivering
// while the app is backgrounded or the screen is locked, subject to OS limits. It
// does NOT guarantee tracking after the user force-closes the app. We never claim
// otherwise. watchPositionAsync (locationEngine.js) is kept for smooth FOREGROUND
// UI only; these tasks are what make passive/active participation work in the
// background.

import * as Location from 'expo-location';
import { supabase } from '../supabase';
import { store } from '../../store';
import { setStatus, setTrackingEnabled } from '../../store/driversSlice';
import {
  DRIVER_STATUS,
  PASSIVE_FAR_INTERVAL_MS,
  PASSIVE_NEAR_INTERVAL_MS,
  ACTIVE_LOCATION_INTERVAL_MS,
  EXIT_GRACE_LOCATION_INTERVAL_MS,
  isActiveParticipationStatus,
} from '../constants';
import {
  LVTAXI_PASSIVE_LOCATION_TASK,
  LVTAXI_ACTIVE_LOCATION_TASK,
} from './trackingTaskNames';
import {
  refreshWorkAreaCache,
  isInsideWorkAreaPolygon,
  classifyPassiveDistance,
} from '../workAreaGeometry';
import { clearDriverPresence } from '../zoneStatsEngine';
import {
  transitionToTrackingDisabled,
  transitionToActive,
  transitionToPassive,
} from '../driverStatusTransitions';
import { recordTrackingDebug } from './trackingDebug';

// Remember the last options we started a task with so we only restart when the
// cadence actually needs to change (restarting flushes the OS subscription).
let currentPassiveMode = null; // DRIVER_STATUS.PASSIVE_FAR | PASSIVE_NEAR
let currentActiveCadence = null; // 'active' | 'exit_grace'

// ── Shared helpers (used by the tasks too) ───────────────────────────────────

// Source of truth for "is there a logged-in driver". Reads the Supabase session
// directly so it works inside a headless background task where Redux may be cold.
export async function getSessionUserId() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch (err) {
    console.warn('[backgroundTracking] getSession failed', err);
    return store.getState().auth.session?.user?.id ?? null;
  }
}

// Dispatch into Redux if the store is available. Best-effort: background tasks
// must not assume the store is hydrated, so failures are swallowed.
export function safeDispatch(action) {
  try {
    store.dispatch(action);
  } catch (err) {
    console.warn('[backgroundTracking] dispatch failed', err);
  }
}

// Persist the driver's automatic status (and any work-area bookkeeping columns)
// to Supabase, and mirror it into Redux. Supabase is the cross-launch source of
// truth that reconciliation reads back on the next app start.
export async function persistDriverStatus(driverId, status, extra = {}) {
  if (status) safeDispatch(setStatus(status));
  if (!driverId) return;
  const patch = { last_seen: new Date().toISOString(), ...extra };
  if (status) patch.status = status;
  const { error } = await supabase.from('drivers').update(patch).eq('id', driverId);
  if (error) {
    console.warn('[backgroundTracking] persist status failed', error.message);
  }
}

export function getLatestLocation(data) {
  const locations = data?.locations;
  if (!locations || locations.length === 0) return null;
  return locations[locations.length - 1] ?? null;
}

// ── Permissions ──────────────────────────────────────────────────────────────
export async function ensureLocationPermissions() {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    return { granted: false, background: false };
  }
  let background = false;
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    background = bg.status === 'granted';
  } catch (err) {
    console.warn('[backgroundTracking] background permission request failed', err);
  }
  return { granted: true, background };
}

async function hasPermissions() {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    return fg.status === 'granted';
  } catch {
    return false;
  }
}

// ── Option builders ──────────────────────────────────────────────────────────
function passiveOptions(mode) {
  const near = mode === DRIVER_STATUS.PASSIVE_NEAR;
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: near ? PASSIVE_NEAR_INTERVAL_MS : PASSIVE_FAR_INTERVAL_MS,
    distanceInterval: near ? 150 : 750,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: 'LV Taxi background tracking',
      notificationBody:
        'Watching for when you reach your work area. No staging queue is affected while you are away.',
      notificationColor: '#F5C518',
    },
  };
}

function activeOptions(cadence) {
  const grace = cadence === 'exit_grace';
  return {
    accuracy: grace ? Location.Accuracy.Balanced : Location.Accuracy.High,
    timeInterval: grace
      ? EXIT_GRACE_LOCATION_INTERVAL_MS
      : ACTIVE_LOCATION_INTERVAL_MS,
    distanceInterval: grace ? 75 : 5,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'LV Taxi is tracking your work area',
      notificationBody: 'Used to keep taxi staging-zone counts accurate.',
      notificationColor: '#F5C518',
    },
  };
}

async function isTaskRunning(taskName) {
  try {
    return await Location.hasStartedLocationUpdatesAsync(taskName);
  } catch {
    return false;
  }
}

async function stopTask(taskName) {
  if (await isTaskRunning(taskName)) {
    try {
      await Location.stopLocationUpdatesAsync(taskName);
    } catch (err) {
      console.warn('[backgroundTracking] stop task failed', taskName, err);
    }
  }
}

// ── Passive tracking ─────────────────────────────────────────────────────────
export async function startPassiveTracking(mode = DRIVER_STATUS.PASSIVE_FAR) {
  if (!(await hasPermissions())) return false;
  // Only one task runs at a time — passive owns the slow watch.
  await stopActiveTracking();

  const alreadyRunning = await isTaskRunning(LVTAXI_PASSIVE_LOCATION_TASK);
  if (alreadyRunning && currentPassiveMode === mode) {
    recordTrackingDebug({ lastTask: 'passive' });
    return true;
  }
  if (alreadyRunning) await stopTask(LVTAXI_PASSIVE_LOCATION_TASK);

  try {
    await Location.startLocationUpdatesAsync(
      LVTAXI_PASSIVE_LOCATION_TASK,
      passiveOptions(mode)
    );
    currentPassiveMode = mode;
    recordTrackingDebug({ lastTask: 'passive' });
    return true;
  } catch (err) {
    console.warn('[backgroundTracking] startPassiveTracking failed', err);
    return false;
  }
}

export async function stopPassiveTracking() {
  await stopTask(LVTAXI_PASSIVE_LOCATION_TASK);
  currentPassiveMode = null;
}

// ── Active tracking ──────────────────────────────────────────────────────────
export async function startActiveTracking() {
  if (!(await hasPermissions())) return false;
  await stopPassiveTracking();

  const alreadyRunning = await isTaskRunning(LVTAXI_ACTIVE_LOCATION_TASK);
  if (alreadyRunning && currentActiveCadence === 'active') {
    recordTrackingDebug({ lastTask: 'active' });
    return true;
  }
  if (alreadyRunning) await stopTask(LVTAXI_ACTIVE_LOCATION_TASK);

  try {
    await Location.startLocationUpdatesAsync(
      LVTAXI_ACTIVE_LOCATION_TASK,
      activeOptions('active')
    );
    currentActiveCadence = 'active';
    recordTrackingDebug({ lastTask: 'active' });
    return true;
  } catch (err) {
    console.warn('[backgroundTracking] startActiveTracking failed', err);
    return false;
  }
}

// EXIT_GRACE reuses the active task (same in-task logic) but at a lighter cadence.
export async function startExitGraceTracking() {
  if (!(await hasPermissions())) return false;
  await stopPassiveTracking();

  const alreadyRunning = await isTaskRunning(LVTAXI_ACTIVE_LOCATION_TASK);
  if (alreadyRunning && currentActiveCadence === 'exit_grace') return true;
  if (alreadyRunning) await stopTask(LVTAXI_ACTIVE_LOCATION_TASK);

  try {
    await Location.startLocationUpdatesAsync(
      LVTAXI_ACTIVE_LOCATION_TASK,
      activeOptions('exit_grace')
    );
    currentActiveCadence = 'exit_grace';
    return true;
  } catch (err) {
    console.warn('[backgroundTracking] startExitGraceTracking failed', err);
    return false;
  }
}

export async function stopActiveTracking() {
  await stopTask(LVTAXI_ACTIVE_LOCATION_TASK);
  currentActiveCadence = null;
}

export async function stopAllBackgroundTracking() {
  await stopPassiveTracking();
  await stopActiveTracking();
}

// ── App-launch reconciliation ────────────────────────────────────────────────
// Called once a session + profile are loaded. No driver interaction required:
// we read permission + tracking_enabled + persisted status + current position and
// (re)start the correct task. This also recovers from an OS-killed background
// task on the next foreground launch.
export async function reconcileTrackingOnAppLaunch() {
  const state = store.getState();
  const driverId = state.auth.session?.user?.id ?? null;

  // 1. No permission → tracking disabled, everything stopped.
  if (!(await hasPermissions())) {
    await stopAllBackgroundTracking();
    await transitionToTrackingDisabled(driverId, 'no-permission');
    recordTrackingDebug({ lastStatus: DRIVER_STATUS.TRACKING_DISABLED });
    return;
  }

  // 2. Tracking explicitly disabled (user toggle / inactive account).
  const trackingEnabled = state.drivers.trackingEnabled !== false;
  if (!trackingEnabled) {
    await stopAllBackgroundTracking();
    if (driverId) await clearDriverPresence(driverId);
    await transitionToTrackingDisabled(driverId, 'tracking-disabled', {
      trackingEnabled: false,
    });
    recordTrackingDebug({ lastStatus: DRIVER_STATUS.TRACKING_DISABLED });
    return;
  }

  await refreshWorkAreaCache({ force: true });

  // 3. Decide from the last persisted status + current position.
  const persistedStatus = state.drivers.profile?.status ?? state.drivers.status;

  // Try to resolve current position so we can pick the right passive cadence and
  // immediately upgrade to ACTIVE if we're already inside the work area.
  let pos = null;
  try {
    pos = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    if (!pos) pos = await Location.getCurrentPositionAsync({});
  } catch (err) {
    console.warn('[backgroundTracking] reconcile position failed', err);
  }

  if (pos?.coords) {
    const { latitude: lat, longitude: lng } = pos.coords;
    if (isInsideWorkAreaPolygon(lat, lng)) {
      await transitionToActive(driverId, {
        workAreaEntryTime: new Date().toISOString(),
      });
      await startActiveTracking();
      recordTrackingDebug({ lastStatus: DRIVER_STATUS.ACTIVE, insideWorkArea: true });
      return;
    }
    // Outside the work area. If the driver was mid-participation (active/staged/
    // exit_grace), honour an in-flight exit grace; otherwise go passive.
    if (isActiveParticipationStatus(persistedStatus)) {
      await startExitGraceTracking();
      safeDispatch(setStatus(DRIVER_STATUS.EXIT_GRACE));
      recordTrackingDebug({ lastStatus: DRIVER_STATUS.EXIT_GRACE, insideWorkArea: false });
      return;
    }
    const mode = classifyPassiveDistance(lat, lng);
    await transitionToPassive(driverId, mode);
    await startPassiveTracking(mode);
    recordTrackingDebug({ lastStatus: mode, insideWorkArea: false });
    return;
  }

  // 4. No position yet — fail safe to passive far (never auto-activate blind).
  await transitionToPassive(driverId, DRIVER_STATUS.PASSIVE_FAR);
  await startPassiveTracking(DRIVER_STATUS.PASSIVE_FAR);
  recordTrackingDebug({ lastStatus: DRIVER_STATUS.PASSIVE_FAR });
}

// Enable tracking from the UI: request permission, flip the flag, start passive.
export async function enableTrackingFromUI() {
  const { granted } = await ensureLocationPermissions();
  if (!granted) {
    safeDispatch(setTrackingEnabled(false));
    return false;
  }
  safeDispatch(setTrackingEnabled(true));
  const driverId = await getSessionUserId();
  if (driverId) {
    await supabase.from('drivers').update({ tracking_enabled: true }).eq('id', driverId);
  }
  await reconcileTrackingOnAppLaunch();
  return true;
}

// Disable tracking from the UI: stop everything, clear presence, persist flag.
export async function disableTrackingFromUI() {
  safeDispatch(setTrackingEnabled(false));
  const driverId = await getSessionUserId();
  await stopAllBackgroundTracking();
  if (driverId) {
    await clearDriverPresence(driverId);
    await transitionToTrackingDisabled(driverId, 'user-disabled', {
      trackingEnabled: false,
    });
  }
  recordTrackingDebug({ lastStatus: DRIVER_STATUS.TRACKING_DISABLED });
}
