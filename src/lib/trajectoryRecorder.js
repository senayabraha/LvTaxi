import { supabase } from './supabase';
import { onSmoothedLocation, getDistanceMeters } from './locationEngine';

const STATIONARY_SPEED_MPS = 0.5;
const STOP_GAP_MS = 3000;

let activeVisitId = null;
let activeZoneCenter = null;
let points = [];
let unsubscribe = null;
let sampleTimer = null;
let lastSampledAt = 0;

function pushPoint(point) {
  const now = point.timestamp ?? Date.now();
  if (now - lastSampledAt < 950) return;
  lastSampledAt = now;
  points.push({
    timestamp: now,
    lat: point.lat,
    lng: point.lng,
    speed: point.speed,
    heading: point.heading,
    accuracy: point.accuracy,
    acceleration: point.acceleration,
  });
}

export function startRecording(visitId, zoneCenter = null) {
  stopRecording();
  activeVisitId = visitId;
  activeZoneCenter = zoneCenter;
  points = [];
  lastSampledAt = 0;

  unsubscribe = onSmoothedLocation((point) => {
    pushPoint(point);
  });
}

export async function stopRecording({ persist = true } = {}) {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }

  const visitId = activeVisitId;
  const collected = points.slice();
  const features = extractFeatures(collected, activeZoneCenter);

  if (persist && visitId && collected.length > 0) {
    const { error } = await supabase.from('trajectories').insert({
      visit_id: visitId,
      gps_points: collected,
      features,
    });
    if (error) {
      console.warn('[trajectoryRecorder] failed to save trajectory', error);
    }
  }

  activeVisitId = null;
  activeZoneCenter = null;
  points = [];
  lastSampledAt = 0;

  return { visitId, gpsPoints: collected, features };
}

export function getCurrentPoints() {
  return points.slice();
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
