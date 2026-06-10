// ── Presence heartbeat ────────────────────────────────────────────────────────
// Continuously refreshes driver_presence.last_ping_at while a driver is on duty
// so a staged/active driver keeps appearing in active_driver_presence (90s TTL).
//
// GPS can fire every 1s in HIGH mode, but the Supabase write is throttled to
// PRESENCE_HEARTBEAT_INTERVAL_MS (~25s) so we don't hammer the backend. Live
// counts come from active_driver_presence via get_zone_live_stats(), NEVER from
// the legacy increment/decrement counters.

import { store } from '../store';
import {
  DRIVER_STATUS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  isHeartbeatStatus,
} from './constants';
import { upsertDriverPresence } from './zoneStatsEngine';
import { recordPresenceWrite } from './locationWritePolicy';
import { recordTrackingDebug } from './backgroundTracking/trackingDebug';
import { isFixAcceptableForPresence } from './presenceGate';
import { SESSION_ID, getDeviceId, getAppVersion, getPlatform } from './deviceIdentity';

let lastHeartbeatAt = 0;

// Reset throttle state — call when tracking stops or status changes so the next
// heartbeat (or a forced one) fires immediately instead of waiting out the window.
export function resetPresenceHeartbeat() {
  lastHeartbeatAt = 0;
}

function recordHeartbeatDebug({
  reason,
  driverId,
  zoneId,
  classification,
  errorMessage,
  success = false,
}) {
  const now = Date.now();
  recordTrackingDebug({
    lastHeartbeatAttemptAt: now,
    lastHeartbeatZoneId: zoneId ?? null,
    lastHeartbeatClassification: classification ?? null,
    lastHeartbeatBlockedReason: reason,
    lastHeartbeatErrorMessage: errorMessage ?? null,
    lastHeartbeatHasDriverId: !!driverId,
    ...(success ? { lastHeartbeatSuccessAt: now, lastHeartbeatAt: now } : {}),
  });
}

// Low-level throttled sender. Returns true if a write was issued.
export async function maybeSendPresenceHeartbeat({
  driverId,
  zoneId,
  classification,
  lat,
  lng,
  speed,
  accuracy,
  heading,
  mocked,
  visitId,
  force = false,
} = {}) {
  if (!driverId) {
    recordHeartbeatDebug({
      reason: 'blocked_no_driver_id',
      driverId,
      zoneId,
      classification,
    });
    return false;
  }
  // A presence row without coordinates is useless for live counts.
  if (lat == null || lng == null) {
    recordHeartbeatDebug({
      reason: 'blocked_no_coordinates',
      driverId,
      zoneId,
      classification,
    });
    return false;
  }
  // Only ACTIVE / STAGED drivers heartbeat. PASSIVE_FAR / PASSIVE_NEAR /
  // EXIT_GRACE / TRACKING_DISABLED (and legacy OFF_DUTY) must NOT write presence
  // — passive drivers are not participating and EXIT_GRACE is cleared instead.
  if (!isHeartbeatStatus(store.getState().drivers.status)) {
    recordHeartbeatDebug({
      reason: 'blocked_status_not_heartbeat',
      driverId,
      zoneId,
      classification,
    });
    return false;
  }

  // Accuracy / anti-spoof gate. A coarse or mocked fix must never count a driver
  // into a queue — drop it BEFORE consuming the throttle window so a good fix
  // moments later still writes. The server eligibility view re-enforces this.
  const gate = isFixAcceptableForPresence({ accuracy, mocked });
  if (!gate.ok) {
    recordHeartbeatDebug({
      reason: `blocked_${gate.reason}`,
      driverId,
      zoneId,
      classification,
    });
    return false;
  }

  const now = Date.now();
  if (!force && now - lastHeartbeatAt < PRESENCE_HEARTBEAT_INTERVAL_MS) {
    recordHeartbeatDebug({
      reason: 'blocked_throttle',
      driverId,
      zoneId,
      classification,
    });
    return false;
  }
  lastHeartbeatAt = now;

  // Lightweight live-presence payload ONLY: a single current position plus the
  // identifiers needed for live counts/staleness. We deliberately do NOT send
  // the buffered trajectory array here — raw GPS history is persisted separately
  // at visit exit. This keeps each heartbeat tiny so a ~25s cadence per driver
  // stays cheap on Supabase.
  const rpcStartedAt = Date.now();
  recordTrackingDebug({ heartbeatRpcStartedAt: rpcStartedAt, heartbeatRpcFinishedAt: null });

  // Device identity is resolved once per launch (cached after the first async
  // lookup). Errors fall back to null — the server accepts null gracefully.
  const deviceId = await getDeviceId().catch(() => null);

  const { error, lastPingAt } = await upsertDriverPresence({
    driverId,
    zoneId: zoneId ?? null,
    classification: classification ?? 'ACTIVE',
    lat,
    lng,
    speed,
    accuracy,
    heading,
    visitId: visitId ?? null,
    deviceId,
    sessionId: SESSION_ID,
    appVersion: getAppVersion(),
    platform: getPlatform(),
  });

  const rpcFinishedAt = Date.now();

  if (error) {
    recordTrackingDebug({
      heartbeatRpcFinishedAt: rpcFinishedAt,
      heartbeatRpcError: error.message,
      heartbeatRpcReturned: null,
      heartbeatDbLastPingAt: null,
      heartbeatDbConfirmedFresh: false,
      heartbeatDbMismatchReason: `rpc_error: ${error.message}`,
    });
    recordHeartbeatDebug({
      reason: 'rpc_error',
      driverId,
      zoneId,
      classification,
      errorMessage: error.message,
    });
    return false;
  }

  // Verify the DB actually wrote a fresh timestamp. The RPC (migration 018)
  // returns the last_ping_at it wrote. If lastPingAt is null the old RPC is
  // deployed (pre-018); treat as unconfirmed rather than blocking the write.
  let confirmedFresh = null;
  let mismatchReason = null;
  const pingMs = lastPingAt ? new Date(lastPingAt).getTime() : null;
  if (pingMs != null) {
    const ageMs = rpcFinishedAt - pingMs;
    if (ageMs > 90_000) {
      confirmedFresh = false;
      mismatchReason = `last_ping_at is ${Math.round(ageMs / 1000)}s old — RPC may not have updated the row`;
    } else {
      confirmedFresh = true;
    }
  }

  recordTrackingDebug({
    heartbeatRpcFinishedAt: rpcFinishedAt,
    heartbeatRpcError: null,
    heartbeatRpcReturned: lastPingAt,
    heartbeatDbLastPingAt: lastPingAt,
    heartbeatDbConfirmedFresh: confirmedFresh,
    heartbeatDbMismatchReason: mismatchReason,
  });

  recordPresenceWrite();
  recordHeartbeatDebug({
    reason: confirmedFresh === false ? 'rpc_stale_ping' : 'success',
    driverId,
    zoneId,
    classification,
    success: confirmedFresh !== false,
  });
  return confirmedFresh !== false;
}

// Map current Redux driver state → presence classification.
//   STAGED, or inside a known zone        → 'STAGING' (counted)
//   near/at a zone but not confirmed       → 'UNKNOWN' (counted)
//   on duty but outside all zones          → 'ACTIVE' with null zone (not counted)
function classificationForState(state) {
  const { status, currentZoneId, isInsideZone } = state.drivers;
  if (status === DRIVER_STATUS.STAGED) return 'STAGING';
  if (currentZoneId && isInsideZone) return 'STAGING';
  if (currentZoneId) return 'UNKNOWN';
  return 'ACTIVE';
}

// Convenience wrapper invoked from locationEngine on every smoothed fix. Reads
// the current driver/zone/location straight from Redux and applies throttling.
export function presenceHeartbeatFromLocation(point) {
  if (!point) {
    recordHeartbeatDebug({ reason: 'blocked_no_coordinates' });
    return;
  }
  const state = store.getState();
  const driverId = state.auth.session?.user?.id ?? null;
  if (!driverId) {
    recordHeartbeatDebug({ reason: 'blocked_no_driver_id' });
    return;
  }
  // Skip passive / exit-grace / disabled — see maybeSendPresenceHeartbeat.
  if (!isHeartbeatStatus(state.drivers.status)) {
    recordHeartbeatDebug({
      reason: 'blocked_status_not_heartbeat',
      driverId,
      zoneId: state.drivers.currentZoneId ?? null,
    });
    return;
  }

  const zoneId = state.drivers.currentZoneId ?? null;
  const classification = classificationForState(state);

  maybeSendPresenceHeartbeat({
    driverId,
    zoneId: classification === 'ACTIVE' ? null : zoneId,
    classification,
    lat: point.lat,
    lng: point.lng,
    speed: point.speed,
    accuracy: point.accuracy,
    heading: point.heading,
    mocked: point.mocked,
  }).catch((err) =>
    console.warn('[presenceHeartbeat] heartbeat failed', err)
  );
}
