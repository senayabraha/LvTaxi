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
  lastPassiveTaskRunAt: null,
  lastActiveTaskRunAt: null,
  lastTaskStatusBefore: null,
  lastTaskStatusAfter: null,
  lastTaskDesiredStatus: null,
  lastTaskDecisionReason: null,
  lastTransitionSource: null,
  lastTransitionPayload: null,
  requestedTrackingMode: null,
  trackingModeAfterTransition: null,
  activeTaskStartRequestedAt: null,
  passiveTaskStopRequestedAt: null,
  activeTaskStartError: null,
  passiveTaskStopError: null,
  passiveTaskStartRequestedAt: null,
  activeTaskStopRequestedAt: null,
  passiveTaskStartError: null,
  activeTaskStopError: null,
  lastHeartbeatAttemptAt: null,
  lastHeartbeatSuccessAt: null,
  lastHeartbeatBlockedReason: null,
  lastHeartbeatZoneId: null,
  lastHeartbeatClassification: null,
  lastHeartbeatErrorMessage: null,
  lastHeartbeatAt: null,          // legacy alias for the last successful heartbeat
  heartbeatRpcStartedAt: null,    // ms epoch when the RPC call began
  heartbeatRpcFinishedAt: null,   // ms epoch when the RPC call returned
  heartbeatRpcError: null,        // error message if the RPC returned an error
  heartbeatRpcReturned: null,     // raw last_ping_at value returned by the RPC
  heartbeatDbLastPingAt: null,    // last_ping_at confirmed from the RPC return value
  heartbeatDbConfirmedFresh: null, // true/false: RPC return value is within 90s of local clock
  heartbeatDbMismatchReason: null, // why freshness check failed, if any
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
