// ── Device and session identity ───────────────────────────────────────────────
// device_id: stable across app launches on the same device. Generated once and
//   persisted to AsyncStorage so the same physical device always has the same id.
// session_id: fresh on every app launch. Timestamp-prefixed so lexical comparison
//   == chronological comparison — the server uses this for last-session-wins
//   deduplication when two devices share one account.
//
// Format: "YYYYMMDDTHHMMSS_<random>" — 16 fixed timestamp chars + underscore +
// random hex so "2026..." always sorts after "2025..." and within the same second
// the random suffix provides uniqueness.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

const DEVICE_ID_KEY = '@lvtaxi/device_id';

function randomHex(len = 24) {
  // Math.random is not cryptographically strong but is fine for a device ID —
  // we only need it to be unique across simultaneous first-launches.
  let out = '';
  while (out.length < len) {
    out += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, len);
}

function timestampPrefix() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${now.getUTCFullYear()}` +
    `${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}` +
    `T` +
    `${pad(now.getUTCHours())}` +
    `${pad(now.getUTCMinutes())}` +
    `${pad(now.getUTCSeconds())}`
  );
}

// Generated fresh each time the JS runtime starts (i.e. each app launch /
// background-task wake-up). Exported so it can be imported once and reused.
export const SESSION_ID = `${timestampPrefix()}_${randomHex(24)}`;

// Returns the stable device_id, loading it from storage or generating it on
// first launch. Safe to call multiple times; resolves immediately after first call.
let _cachedDeviceId = null;

export async function getDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;

  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      _cachedDeviceId = stored;
      return _cachedDeviceId;
    }
  } catch (_) {}

  const generated = `${timestampPrefix()}_${randomHex(24)}`;
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, generated);
  } catch (_) {}
  _cachedDeviceId = generated;
  return _cachedDeviceId;
}

export function getAppVersion() {
  // expo-constants would give nativeAppVersion but isn't imported here to keep
  // the dependency footprint minimal. Return null; callers treat null gracefully.
  return null;
}

export function getPlatform() {
  return Platform.OS ?? null;
}

// Convenience: device model string for debug/admin context (not sent to presence).
export function getDeviceModel() {
  return Device.modelName ?? null;
}
