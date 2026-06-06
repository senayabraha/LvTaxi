// ── Centralized driver status / zone transitions ─────────────────────────────
// Single funnel for changing a driver's automatic participation state. Before
// this helper, status and zone were written from many places via separate
// dispatches (setStatus + setCurrentZone) plus a separate Supabase update
// (persistDriverStatus). Those could interleave and leave the app in an
// inconsistent state — most visibly: status = passive_far while currentZoneId
// still points at a zone, so the UI shows "You are here" with a 0 count.
//
// Each function here:
//   1. Sets ALL related Redux fields in ONE dispatch (setDriverParticipationState)
//      so status, currentZoneId, isInsideZone, zoneEntryTime and
//      workAreaExitStartedAt can never disagree.
//   2. Persists the matching `drivers` columns to Supabase — but ONLY when the
//      status/zone actually changed, so we never add an extra write per GPS tick.
//
// This helper deliberately does NOT send presence heartbeats and does NOT start
// or stop the background location tasks. Those concerns stay where they are
// (presenceHeartbeat.js and backgroundTrackingService.js) so this stays small,
// focused and free of import cycles.

import { store } from '../store';
import { setDriverParticipationState } from '../store/driversSlice';
import { supabase } from './supabase';
import { DRIVER_STATUS } from './constants';

function nowIso() {
  return new Date().toISOString();
}

// Apply the Redux participation state in one dispatch, then (optionally) persist
// the `drivers` row. `persist` is the only gate on Supabase writes.
async function commit(driverId, redux, { persist = false, supabasePatch } = {}) {
  store.dispatch(setDriverParticipationState(redux));
  if (!driverId || !persist) return;
  const { error } = await supabase
    .from('drivers')
    .update({ last_seen: nowIso(), ...supabasePatch })
    .eq('id', driverId);
  if (error) {
    console.warn('[driverStatusTransitions] persist failed', error.message);
  }
}

// ── passive_far / passive_near ───────────────────────────────────────────────
// Outside the work area. Never counted, never heartbeats. Always clears the zone
// so a stale currentZoneId can't survive into a passive state.
//   preserveExitGrace — keep an in-flight work_area_exit_started_at (rare).
//   workAreaExitTime  — stamp drivers.work_area_exit_time (grace expiry only).
export async function transitionToPassive(
  driverId,
  status,
  { preserveExitGrace = false, workAreaExitTime } = {}
) {
  const passive =
    status === DRIVER_STATUS.PASSIVE_NEAR
      ? DRIVER_STATUS.PASSIVE_NEAR
      : DRIVER_STATUS.PASSIVE_FAR;

  const cur = store.getState().drivers;
  const changed =
    cur.status !== passive ||
    cur.currentZoneId != null ||
    (!preserveExitGrace && cur.workAreaExitStartedAt != null);

  await commit(
    driverId,
    {
      status: passive,
      currentZoneId: null,
      isInsideZone: false,
      zoneEntryTime: null,
      workAreaExitStartedAt: preserveExitGrace
        ? cur.workAreaExitStartedAt ?? null
        : null,
    },
    {
      persist: changed,
      supabasePatch: {
        status: passive,
        current_zone_id: null,
        ...(preserveExitGrace ? {} : { work_area_exit_started_at: null }),
        ...(workAreaExitTime ? { work_area_exit_time: workAreaExitTime } : {}),
      },
    }
  );
}

// ── active ───────────────────────────────────────────────────────────────────
// Inside the work area but not in any staging zone. Heartbeats (elsewhere) with a
// null zone, so never counted toward a queue. Zone is always cleared here.
export async function transitionToActive(driverId, { workAreaEntryTime } = {}) {
  const cur = store.getState().drivers;
  const changed =
    cur.status !== DRIVER_STATUS.ACTIVE || cur.currentZoneId != null;

  await commit(
    driverId,
    {
      status: DRIVER_STATUS.ACTIVE,
      currentZoneId: null,
      isInsideZone: false,
      zoneEntryTime: null,
      workAreaExitStartedAt: null,
    },
    {
      persist: changed,
      supabasePatch: {
        status: DRIVER_STATUS.ACTIVE,
        current_zone_id: null,
        work_area_exit_started_at: null,
        ...(workAreaEntryTime
          ? { work_area_entry_time: workAreaEntryTime }
          : {}),
      },
    }
  );
}

// ── staged ───────────────────────────────────────────────────────────────────
// Inside a staging-zone polygon. The ONLY counted state. Requires a zoneId.
//   force — persist even if already staged in the same zone (manual confirm).
// zoneEntryTime is preserved when re-confirming the same zone so dwell / queue
// position don't reset.
export async function transitionToStaged(
  driverId,
  zoneId,
  { force = false, workAreaEntryTime } = {}
) {
  if (!zoneId) {
    console.warn(
      '[driverStatusTransitions] transitionToStaged requires a zoneId; ignoring'
    );
    return false;
  }

  const cur = store.getState().drivers;
  const sameZone =
    cur.status === DRIVER_STATUS.STAGED && cur.currentZoneId === zoneId;
  const zoneEntryTime =
    sameZone && cur.zoneEntryTime ? cur.zoneEntryTime : Date.now();

  await commit(
    driverId,
    {
      status: DRIVER_STATUS.STAGED,
      currentZoneId: zoneId,
      isInsideZone: true,
      zoneEntryTime,
      workAreaExitStartedAt: null,
    },
    {
      persist: !sameZone || force,
      supabasePatch: {
        status: DRIVER_STATUS.STAGED,
        current_zone_id: zoneId,
        work_area_exit_started_at: null,
        ...(workAreaEntryTime
          ? { work_area_entry_time: workAreaEntryTime }
          : {}),
      },
    }
  );
  return true;
}

// ── exit_grace ───────────────────────────────────────────────────────────────
// Just left the work area. Not counted; zone cleared. Persists only when first
// entering grace so the 30-min window isn't rewritten on every fix. Returns the
// resolved start timestamp (ms).
export async function transitionToExitGrace(driverId, { startedAt } = {}) {
  const cur = store.getState().drivers;
  const startedMs = startedAt ?? cur.workAreaExitStartedAt ?? Date.now();
  const alreadyInGrace =
    cur.status === DRIVER_STATUS.EXIT_GRACE &&
    cur.workAreaExitStartedAt != null &&
    cur.currentZoneId == null;

  await commit(
    driverId,
    {
      status: DRIVER_STATUS.EXIT_GRACE,
      currentZoneId: null,
      isInsideZone: false,
      zoneEntryTime: null,
      workAreaExitStartedAt: startedMs,
    },
    {
      persist: !alreadyInGrace,
      supabasePatch: {
        status: DRIVER_STATUS.EXIT_GRACE,
        current_zone_id: null,
        work_area_exit_started_at: new Date(startedMs).toISOString(),
      },
    }
  );
  return startedMs;
}

// ── tracking_disabled ────────────────────────────────────────────────────────
// Logout / revoked permission / inactive account / user toggle. Always persisted.
//   trackingEnabled:false also flips drivers.tracking_enabled.
// (Does not clear the presence row — callers that need that still call
//  clearDriverPresence(), keeping this helper free of zoneStatsEngine imports.)
export async function transitionToTrackingDisabled(
  driverId,
  _reason,
  { trackingEnabled } = {}
) {
  await commit(
    driverId,
    {
      status: DRIVER_STATUS.TRACKING_DISABLED,
      currentZoneId: null,
      isInsideZone: false,
      zoneEntryTime: null,
      workAreaExitStartedAt: null,
    },
    {
      persist: true,
      supabasePatch: {
        status: DRIVER_STATUS.TRACKING_DISABLED,
        current_zone_id: null,
        work_area_exit_started_at: null,
        ...(trackingEnabled === false ? { tracking_enabled: false } : {}),
      },
    }
  );
}
