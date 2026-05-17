import * as Location from 'expo-location';
import KalmanFilter from 'kalmanjs';
import { store } from '../store';
import { setLocation } from '../store/driversSlice';

const KALMAN_R = 0.01;
const KALMAN_Q = 3;

export class KalmanLocationFilter {
  constructor() {
    this.latFilter = new KalmanFilter({ R: KALMAN_R, Q: KALMAN_Q });
    this.lngFilter = new KalmanFilter({ R: KALMAN_R, Q: KALMAN_Q });
  }

  filter(rawLat, rawLng) {
    return {
      smoothedLat: this.latFilter.filter(rawLat),
      smoothedLng: this.lngFilter.filter(rawLng),
    };
  }

  reset() {
    this.latFilter = new KalmanFilter({ R: KALMAN_R, Q: KALMAN_Q });
    this.lngFilter = new KalmanFilter({ R: KALMAN_R, Q: KALMAN_Q });
  }
}

const EARTH_RADIUS_M = 6371000;

export function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

function computeHeading(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

let kalman = null;
let subscription = null;
let lastPoint = null;
let lastDispatchAt = 0;
let stationarySince = null;
let lowPowerMode = false;
let currentMode = 'high';
const DISPATCH_INTERVAL_MS = 1000;
const STATIONARY_SPEED_MPS = 0.5;
const STATIONARY_TO_LOW_POWER_MS = 10 * 60 * 1000;
const MOTION_TO_HIGH_POWER_MPS = 1.5;
const listeners = new Set();

export const GPS_MODE = {
  HIGH: 'high',       // active/staged — 1s, Accuracy.BestForNavigation
  LOW: 'low',         // stationary in zone — 5s, Accuracy.Balanced (auto)
  PASSIVE: 'passive', // off-duty — 5min, Accuracy.Balanced
};

export function onSmoothedLocation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function modeOptions(mode) {
  if (mode === GPS_MODE.PASSIVE) {
    return {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 300_000,
      distanceInterval: 25,
    };
  }
  if (mode === GPS_MODE.LOW) {
    return {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 5000,
      distanceInterval: 5,
    };
  }
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,
    distanceInterval: 0.5,
  };
}

async function startWatcher(mode) {
  return Location.watchPositionAsync(modeOptions(mode), handleLocationUpdate);
}

async function switchMode(mode) {
  if (currentMode === mode) return;
  currentMode = mode;
  lowPowerMode = mode !== GPS_MODE.HIGH;
  if (subscription) {
    subscription.remove();
    subscription = null;
  }
  try {
    subscription = await startWatcher(mode);
  } catch (err) {
    console.warn('[locationEngine] mode switch failed', err);
  }
}

export async function setGPSMode(mode) {
  return switchMode(mode);
}

export function getGPSMode() {
  return currentMode;
}

// Auto-throttle between HIGH and LOW based on motion when on-duty.
// Does NOT touch PASSIVE mode (off-duty is set explicitly by status).
function maybeSwitchPowerMode(speed, timestamp) {
  if (currentMode === GPS_MODE.PASSIVE) return;
  const moving = (speed ?? 0) >= MOTION_TO_HIGH_POWER_MPS;
  if (moving) {
    stationarySince = null;
    if (currentMode === GPS_MODE.LOW) switchMode(GPS_MODE.HIGH);
    return;
  }
  if ((speed ?? 0) < STATIONARY_SPEED_MPS) {
    if (stationarySince == null) stationarySince = timestamp;
    if (
      currentMode === GPS_MODE.HIGH &&
      timestamp - stationarySince >= STATIONARY_TO_LOW_POWER_MS
    ) {
      switchMode(GPS_MODE.LOW);
    }
  }
}

function handleLocationUpdate(loc) {
  if (!kalman) return;
  const { latitude, longitude, accuracy, speed, heading } = loc.coords;
  const timestamp = loc.timestamp ?? Date.now();
  const { smoothedLat, smoothedLng } = kalman.filter(latitude, longitude);

  let derivedSpeed = speed ?? null;
  let derivedHeading = heading ?? null;
  let derivedAcceleration = null;

  if (lastPoint) {
    const dtSec = Math.max((timestamp - lastPoint.timestamp) / 1000, 0.001);
    const distance = getDistanceMeters(
      lastPoint.lat,
      lastPoint.lng,
      smoothedLat,
      smoothedLng
    );
    const instSpeed = distance / dtSec;
    if (derivedSpeed == null || derivedSpeed < 0) derivedSpeed = instSpeed;
    if (derivedHeading == null || derivedHeading < 0) {
      derivedHeading = computeHeading(
        lastPoint.lat,
        lastPoint.lng,
        smoothedLat,
        smoothedLng
      );
    }
    if (lastPoint.speed != null) {
      derivedAcceleration = (derivedSpeed - lastPoint.speed) / dtSec;
    }
  }

  const point = {
    timestamp,
    lat: smoothedLat,
    lng: smoothedLng,
    rawLat: latitude,
    rawLng: longitude,
    accuracy,
    speed: derivedSpeed,
    heading: derivedHeading,
    acceleration: derivedAcceleration,
  };

  lastPoint = point;

  for (const listener of listeners) {
    try {
      listener(point);
    } catch (err) {
      console.warn('[locationEngine] listener error', err);
    }
  }

  if (timestamp - lastDispatchAt >= DISPATCH_INTERVAL_MS) {
    lastDispatchAt = timestamp;
    store.dispatch(
      setLocation({
        lat: smoothedLat,
        lng: smoothedLng,
        accuracy,
        speed: derivedSpeed,
        heading: derivedHeading,
        acceleration: derivedAcceleration,
      })
    );
  }

  maybeSwitchPowerMode(derivedSpeed, timestamp);
}

export async function startLocationTracking(mode = GPS_MODE.HIGH) {
  if (subscription) {
    if (currentMode !== mode) await switchMode(mode);
    return subscription;
  }

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    throw new Error('Foreground location permission denied');
  }
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    console.warn(
      '[locationEngine] Background location not granted — geofencing will only fire in foreground.'
    );
  }

  kalman = new KalmanLocationFilter();
  lastPoint = null;
  lastDispatchAt = 0;
  stationarySince = null;
  lowPowerMode = mode !== GPS_MODE.HIGH;
  currentMode = mode;

  subscription = await startWatcher(mode);
  return subscription;
}

export function stopLocationTracking() {
  if (subscription) {
    subscription.remove();
    subscription = null;
  }
  kalman = null;
  lastPoint = null;
  lastDispatchAt = 0;
  stationarySince = null;
  lowPowerMode = false;
  currentMode = 'high';
}

export function getLastSmoothedPoint() {
  return lastPoint;
}
