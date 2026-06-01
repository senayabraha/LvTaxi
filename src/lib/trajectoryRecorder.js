// ── Trajectory recorder ───────────────────────────────────────────────────────
// Buffers raw GPS fixes for the active visit IN MEMORY ONLY. There is NO
// per-point write to Supabase here — points are handed back to visitProcessor on
// zone exit, which persists them as a single row (one visit = one write). The
// buffer is bounded by TRAJECTORY_MAX_BUFFER_POINTS so a long visit can never
// grow it without limit.
import { onSmoothedLocation, getDistanceMeters } from './locationEngine';
import { TRAJECTORY_MAX_BUFFER_POINTS } from './constants';

const STATIONARY_SPEED_MPS = 0.5;
const STOP_GAP_MS = 3000;
// Local sampling floor: even though HIGH-mode GPS can fire every 1s, we keep at
// most ~1 buffered point/sec so the in-memory buffer stays lean. This is a local
// throttle on the BUFFER, not a backend write.
const MIN_SAMPLE_GAP_MS = 950;

let activeVisitId = null;
let activeZoneCenter = null;
let points = [];
let unsubscribe = null;
let sampleTimer = null;
let lastSampledAt = 0;

// Keep the buffer bounded. When we exceed the cap, drop every other point from
// the *middle* of the buffer (downsample) while always preserving the first and
// last fixes — entry/exit speed and dwell endpoints must survive so the visit
// can still be classified. This halves resolution gracefully instead of
// dropping the newest data or letting the array grow forever.
function enforceBufferLimit() {
  if (points.length <= TRAJECTORY_MAX_BUFFER_POINTS) return;
  const first = points[0];
  const last = points[points.length - 1];
  const middle = points.slice(1, points.length - 1);
  const downsampled = middle.filter((_, i) => i % 2 === 0);
  points = [first, ...downsampled, last];
}

// Append a single fix to the local buffer only. Never writes to Supabase.
export function appendTrajectoryPoint(point) {
  if (!point) return;
  const now = point.timestamp ?? Date.now();
  if (now - lastSampledAt < MIN_SAMPLE_GAP_MS) return;
  lastSampledAt = now;
  points.push({
    timestamp: now,
    lat: point.lat,
    lng: point.lng,
    accuracy: point.accuracy,
    speed: point.speed,
    heading: point.heading,
    acceleration: point.acceleration,
  });
  enforceBufferLimit();
}

// Synchronous teardown of the in-memory recording state. Unsubscribes from the
// location stream and clears the buffer WITHOUT any async/Supabase work, so it
// is safe to call from startRecording without awaiting.
function resetRecordingState() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  activeVisitId = null;
  activeZoneCenter = null;
  points = [];
  lastSampledAt = 0;
}

export function startRecording(visitId, zoneCenter = null) {
  // Reset synchronously so a quick zone→zone transition can't race a half-torn-
  // down recorder (previously stopRecording() was async and left unawaited).
  resetRecordingState();
  activeVisitId = visitId;
  activeZoneCenter = zoneCenter;

  unsubscribe = onSmoothedLocation((point) => {
    appendTrajectoryPoint(point);
  });
}

// Stop recording and hand the buffered points back to the caller. This NEVER
// writes to Supabase — persistence is owned by visitProcessor.processZoneExit
// (one upsert per visit). The `persist` option is retained only for call-site
// back-compat and is intentionally a no-op; passing it does not create a write.
export function stopRecording(_opts = {}) {
  const visitId = activeVisitId;
  const collected = points.slice();
  const features = extractFeatures(collected, activeZoneCenter);

  resetRecordingState();

  return { visitId, gpsPoints: collected, features };
}

export function getCurrentPoints() {
  return points.slice();
}

// ── Buffer helpers ────────────────────────────────────────────────────────────

// Read-only snapshot of the current in-memory buffer.
export function getTrajectoryBuffer() {
  return points.slice();
}

// Return a copy of the buffer for an intermediate batch flush WITHOUT clearing
// the active visit. Intended for a future long-visit / backgrounding batch path;
// callers are responsible for persisting the returned points as a single batch
// (never one write per point). Today the default flow uses finalizeTrajectory at
// exit instead, so this is provided for completeness/hardening.
export function flushTrajectoryBatch({ reason = 'manual' } = {}) {
  const batch = points.slice();
  return { visitId: activeVisitId, reason, points: batch };
}

// Finalize the active visit: returns the buffered points + extracted features so
// visitProcessor can persist them as one row, then clears local state.
export function finalizeTrajectory({ visitId } = {}) {
  const collected = points.slice();
  const features = extractFeatures(collected, activeZoneCenter);
  const id = visitId ?? activeVisitId;
  clearTrajectoryBuffer();
  return { visitId: id, gpsPoints: collected, features };
}

// Drop everything without persisting. Used after a successful flush/finalize or
// when a visit is abandoned.
export function clearTrajectoryBuffer() {
  points = [];
  lastSampledAt = 0;
  activeVisitId = null;
  activeZoneCenter = null;
}

export function extractFeatures(gpsPoints, zoneCenter = null) {
  if (!gpsPoints || gpsPoints.length === 0) {
    return {
      entrySpeed: 0,
      exitSpeed: 0,
      avgSpeedInZone: 0,
      maxSpeedInZone: 0,
      dwellTime: 0,
      timeStationary: 0,
      positionVariance: 0,
      headingChange: 0,
      forwardCreep: 0,
      stopCount: 0,
      entryAcceleration: 0,
      exitAcceleration: 0,
      pointCount: 0,
    };
  }

  const first = gpsPoints[0];
  const last = gpsPoints[gpsPoints.length - 1];

  const speeds = gpsPoints.map((p) => p.speed ?? 0);
  const avgSpeedInZone =
    speeds.reduce((a, b) => a + b, 0) / Math.max(speeds.length, 1);
  const maxSpeedInZone = speeds.reduce((m, s) => (s > m ? s : m), 0);

  const dwellTime = Math.max(0, (last.timestamp - first.timestamp) / 1000);

  let timeStationary = 0;
  for (let i = 1; i < gpsPoints.length; i++) {
    const prev = gpsPoints[i - 1];
    const curr = gpsPoints[i];
    const dt = (curr.timestamp - prev.timestamp) / 1000;
    if ((curr.speed ?? 0) < STATIONARY_SPEED_MPS) {
      timeStationary += dt;
    }
  }

  const meanLat =
    gpsPoints.reduce((a, p) => a + p.lat, 0) / gpsPoints.length;
  const meanLng =
    gpsPoints.reduce((a, p) => a + p.lng, 0) / gpsPoints.length;
  const positionVariance =
    gpsPoints.reduce(
      (acc, p) => acc + getDistanceMeters(p.lat, p.lng, meanLat, meanLng) ** 2,
      0
    ) / gpsPoints.length;

  let headingChange = 0;
  for (let i = 1; i < gpsPoints.length; i++) {
    const a = gpsPoints[i - 1].heading;
    const b = gpsPoints[i].heading;
    if (a == null || b == null) continue;
    let diff = Math.abs(b - a) % 360;
    if (diff > 180) diff = 360 - diff;
    headingChange += diff;
  }

  let forwardCreep = 0;
  if (zoneCenter) {
    const startDist = getDistanceMeters(
      first.lat,
      first.lng,
      zoneCenter.lat,
      zoneCenter.lng
    );
    const endDist = getDistanceMeters(
      last.lat,
      last.lng,
      zoneCenter.lat,
      zoneCenter.lng
    );
    forwardCreep = startDist - endDist;
  } else {
    forwardCreep = getDistanceMeters(
      first.lat,
      first.lng,
      last.lat,
      last.lng
    );
  }

  let stopCount = 0;
  let inStop = false;
  let stopStart = 0;
  for (const p of gpsPoints) {
    const stopped = (p.speed ?? 0) < STATIONARY_SPEED_MPS;
    if (stopped && !inStop) {
      inStop = true;
      stopStart = p.timestamp;
    } else if (!stopped && inStop) {
      inStop = false;
      if (p.timestamp - stopStart >= STOP_GAP_MS) stopCount++;
    }
  }
  if (inStop && last.timestamp - stopStart >= STOP_GAP_MS) stopCount++;

  const entrySlice = gpsPoints.slice(0, Math.min(5, gpsPoints.length));
  const exitSlice = gpsPoints.slice(-Math.min(5, gpsPoints.length));
  const accels = (slice) =>
    slice
      .map((p) => p.acceleration)
      .filter((v) => v != null && !Number.isNaN(v));
  const avg = (arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    entrySpeed: first.speed ?? 0,
    exitSpeed: last.speed ?? 0,
    avgSpeedInZone,
    maxSpeedInZone,
    dwellTime,
    timeStationary,
    positionVariance,
    headingChange,
    forwardCreep,
    stopCount,
    entryAcceleration: avg(accels(entrySlice)),
    exitAcceleration: avg(accels(exitSlice)),
    pointCount: gpsPoints.length,
  };
}
