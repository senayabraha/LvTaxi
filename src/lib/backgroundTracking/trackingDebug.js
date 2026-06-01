// Lightweight in-memory debug state for the automatic tracking system.
//
// The background tasks run with no UI attached, so they record what they did into
// this tiny store. A dev-only debug panel (TrackingDebugPanel) reads it. Nothing
// here is persisted or written to Supabase — it only helps verify the state
// machine on-device.

let debugState = {
  lastBackgroundLocationAt: null, // ms epoch of the last background fix processed
  lastBackgroundLat: null,
  lastBackgroundLng: null,
  insideWorkArea: null,           // true / false / null (unknown)
  detectedZoneId: null,
  detectedZoneName: null,
  lastTask: null,                 // 'passive' | 'active'
  lastHeartbeatAt: null,
  workAreaExitStartedAt: null,
  lastStatus: null,
  workAreaPolygonCount: null,
};

const listeners = new Set();

export function recordTrackingDebug(patch) {
  debugState = { ...debugState, ...patch };
  for (const l of listeners) {
    try {
      l(debugState);
    } catch {}
  }
}

export function getTrackingDebug() {
  return debugState;
}

export function subscribeTrackingDebug(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
