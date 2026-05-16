import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { store } from '../store';
import { supabase } from './supabase';
import { getDistanceMeters } from './locationEngine';
import { DRIVER_STATUS } from './constants';
import { initNotifications } from './notificationService';

const NEARBY_RADIUS_M = 804;
const NEARBY_WAIT_THRESHOLD_MIN = 10;
const NEARBY_COOLDOWN_MIN = 30;
const QUEUE_UPDATE_DELTA_MIN = 5;
const NEARBY_INTERVAL_MS = 2 * 60 * 1000;

let nearbyTimer = null;
let lastWaitByZone = new Map();

export async function requestPermissions() {
  await initNotifications();
  const settings = await Notifications.getPermissionsAsync();
  if (settings.status === 'granted') return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.status === 'granted';
}

export async function registerPushToken() {
  if (!Device.isDevice) return null;
  const ok = await requestPermissions();
  if (!ok) return null;

  let token = null;
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const res = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    token = res.data;
  } catch (err) {
    console.warn('[notificationEngine] token fetch failed', err);
    return null;
  }

  const driverId = store.getState().drivers.session?.user?.id;
  if (driverId && token) {
    const { error } = await supabase
      .from('drivers')
      .update({ push_token: token, device_platform: Platform.OS })
      .eq('id', driverId);
    if (error) console.warn('[notificationEngine] save token failed', error);
  }
  return token;
}

async function isOnCooldown(driverId, zoneId, kind, cooldownMin) {
  const { data, error } = await supabase
    .from('driver_zone_notifications')
    .select('last_sent_at')
    .eq('driver_id', driverId)
    .eq('zone_id', zoneId)
    .eq('kind', kind)
    .maybeSingle();
  if (error || !data) return false;
  const last = new Date(data.last_sent_at).getTime();
  return Date.now() - last < cooldownMin * 60 * 1000;
}

async function recordSent(driverId, zoneId, kind) {
  await supabase.from('driver_zone_notifications').upsert(
    {
      driver_id: driverId,
      zone_id: zoneId,
      kind,
      last_sent_at: new Date().toISOString(),
    },
    { onConflict: 'driver_id,zone_id,kind' }
  );
}

async function logNotification(driverId, zoneId, type, message) {
  await supabase.from('notifications').insert({
    driver_id: driverId,
    zone_id: zoneId,
    type,
    message,
  });
}

async function sendLocal(title, body, data) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: null,
  });
}

async function evaluateNearbyZones() {
  const state = store.getState();
  if (state.drivers.status !== DRIVER_STATUS.ACTIVE) return;
  const driverId = state.drivers.session?.user?.id;
  const { currentLat, currentLng } = state.drivers;
  if (!driverId || currentLat == null || currentLng == null) return;

  const { allZones, stats } = state.zones;
  for (const zone of allZones) {
    const d = getDistanceMeters(currentLat, currentLng, zone.lat, zone.lng);
    if (d > NEARBY_RADIUS_M) continue;
    const stat = stats[zone.id];
    const wait = stat?.wait_time_minutes;
    if (wait == null || wait >= NEARBY_WAIT_THRESHOLD_MIN) continue;
    if (await isOnCooldown(driverId, zone.id, 'nearby', NEARBY_COOLDOWN_MIN)) {
      continue;
    }
    const cars = stat?.cars_staged ?? 0;
    const msg = `📍 ${zone.name} — only ${Math.round(
      wait
    )} mins wait, ${cars} cars staged`;
    try {
      await sendLocal('Nearby short wait', msg, {
        zoneId: zone.id,
        kind: 'nearby',
      });
      await recordSent(driverId, zone.id, 'nearby');
      await logNotification(driverId, zone.id, 'nearby', msg);
    } catch (err) {
      console.warn('[notificationEngine] nearby send failed', err);
    }
  }
}

function evaluateQueueUpdate() {
  const state = store.getState();
  if (state.drivers.status !== DRIVER_STATUS.STAGED) {
    lastWaitByZone.clear();
    return;
  }
  const zoneId = state.drivers.currentZoneId;
  if (!zoneId) return;
  const driverId = state.drivers.session?.user?.id;
  const stat = state.zones.stats[zoneId];
  const wait = stat?.wait_time_minutes;
  if (wait == null || !driverId) return;

  const prev = lastWaitByZone.get(zoneId);
  if (prev == null) {
    lastWaitByZone.set(zoneId, wait);
    return;
  }
  if (Math.abs(wait - prev) >= QUEUE_UPDATE_DELTA_MIN) {
    const zone = state.zones.allZones.find((z) => z.id === zoneId);
    const name = zone?.name ?? 'your zone';
    const msg = `⏱️ Your wait at ${name} updated: now ~${Math.round(wait)} mins`;
    sendLocal('Queue update', msg, { zoneId, kind: 'queue_update' }).catch(() => {});
    logNotification(driverId, zoneId, 'queue_update', msg).catch(() => {});
    lastWaitByZone.set(zoneId, wait);
  }
}

let unsubscribeStore = null;

export function startNotificationEngine() {
  if (nearbyTimer) return;
  requestPermissions().catch(() => {});
  registerPushToken().catch(() => {});

  nearbyTimer = setInterval(evaluateNearbyZones, NEARBY_INTERVAL_MS);
  evaluateNearbyZones().catch(() => {});

  unsubscribeStore = store.subscribe(() => {
    evaluateQueueUpdate();
  });
}

export function stopNotificationEngine() {
  if (nearbyTimer) {
    clearInterval(nearbyTimer);
    nearbyTimer = null;
  }
  if (unsubscribeStore) {
    unsubscribeStore();
    unsubscribeStore = null;
  }
  lastWaitByZone.clear();
}
