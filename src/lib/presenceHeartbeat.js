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
} from './constants';
import { upsertDriverPresence } from './zoneStatsEngine';
import { recordPresenceWrite } from './locationWritePolicy';

let lastHeartbeatAt = 0;

// Reset throttle state — call when tracking stops or status changes so the next
// heartbeat (or a forced one) fires immediately instead of waiting out the window.
export function resetPresenceHeartbeat() {
  lastHeartbeatAt = 0;
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
  visitId,
  force = false,
} = {}) {
  if (!driverId) return false;
  // A presence row without coordinates is useless for live counts.
  if (lat == null || lng == null) return false;
  // Off-duty drivers must not heartbeat — going off duty clears presence instead.
  if (store.getState().drivers.status === DRIVER_STATUS.OFF_DUTY) return false;

  const now = Date.now();
  if (!force && now - lastHeartbeatAt < PRESENCE_HEARTBEAT_INTERVAL_MS) {
    return false;
  }
  lastHeartbeatAt = now;

  // Lightweight live-presence payload ONLY: a single current position plus the
  // identifiers needed for live counts/staleness. We deliberately do NOT send
  // the buffered trajectory array here — raw GPS history is persisted separately
  // at visit exit. This keeps each heartbeat tiny so a ~25s cadence per driver
  // stays cheap on Supabase.
  await upsertDriverPresence({
    driverId,
    zoneId: zoneId ?? null,
    classification: classification ?? 'ACTIVE',
    lat,
    lng,
    speed,
    accuracy,
    heading,
    visitId: visitId ?? null,
  });
  recordPresenceWrite();
  return true;
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
  if (!point) return;
  const state = store.getState();
  const driverId = state.auth.session?.user?.id ?? null;
  if (!driverId) return;
  if (state.drivers.status === DRIVER_STATUS.OFF_DUTY) return;

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
  }).catch((err) =>
    console.warn('[presenceHeartbeat] heartbeat failed', err)
  );
}
