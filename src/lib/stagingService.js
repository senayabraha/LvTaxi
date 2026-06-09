// ── Staging service ───────────────────────────────────────────────────────────
// Single entry point for all "driver is now staged in a zone" operations.
// Consolidates the four previously divergent paths (geofence / active task /
// passive task / manual button) so every staging event:
//   1. Transitions status + ensures exactly one open zone_visits row
//   2. Resets the presence-heartbeat throttle (zone change → immediate write)
//   3. Starts trajectory recording for exit classification
//   4. Forces one immediate presence write so the driver is counted now
//
// Callers that need to register a visit with the geofence engine (so handleExit
// can look it up) must call registerActiveVisit(zoneId, visitId) themselves —
// kept in geofenceEngine to avoid a circular import.
//
// Returns { ok, visitId, heartbeatSent }.

import { transitionToStaged } from './driverStatusTransitions';
import { resetPresenceHeartbeat, maybeSendPresenceHeartbeat } from './presenceHeartbeat';
import { startRecording } from './trajectoryRecorder';

export async function enterStagingZone({
  driverId,
  zoneId,
  zone = null,
  source = 'unknown',
  lat = null,
  lng = null,
  speed = null,
  accuracy = null,
  heading = null,
  mocked = false,
  skipTaskRestart = false,
} = {}) {
  // 1. Status transition + ensure open zone_visits row (idempotent)
  const result = await transitionToStaged(driverId, zoneId, {
    source,
    skipTaskRestart,
  });
  const visitId = result.visitId ?? null;

  // 2. Reset throttle so the forced write below (and the next regular heartbeat)
  //    are not blocked by the previous zone's 25 s window.
  resetPresenceHeartbeat();

  // 3. Start buffering GPS points for this visit's exit classification.
  const zoneCenter = zone ? { lat: zone.lat, lng: zone.lng } : null;
  startRecording(visitId, zoneCenter);

  // 4. Force an immediate presence write if we have coordinates so the driver
  //    appears in live counts without waiting for the next throttle window.
  let heartbeatSent = false;
  if (driverId && lat != null && lng != null) {
    try {
      heartbeatSent = await maybeSendPresenceHeartbeat({
        driverId,
        zoneId,
        classification: 'STAGING',
        lat,
        lng,
        speed,
        accuracy,
        heading,
        mocked,
        visitId,
        force: true,
      });
    } catch (err) {
      console.warn('[stagingService] forced heartbeat failed', err);
    }
  }

  return { ok: result.ok, visitId, heartbeatSent };
}
