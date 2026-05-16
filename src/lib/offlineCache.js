import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_ZONES = 'lvtaxi:cache:zones:v1';
const KEY_STATS = 'lvtaxi:cache:zone_stats:v1';
const KEY_STATS_AT = 'lvtaxi:cache:zone_stats:updated_at:v1';

export async function saveZonesCache(zones) {
  try {
    await AsyncStorage.setItem(KEY_ZONES, JSON.stringify(zones));
  } catch (err) {
    console.warn('[offlineCache] saveZonesCache failed', err);
  }
}

export async function saveStatsCache(stats) {
  try {
    await AsyncStorage.multiSet([
      [KEY_STATS, JSON.stringify(stats)],
      [KEY_STATS_AT, String(Date.now())],
    ]);
  } catch (err) {
    console.warn('[offlineCache] saveStatsCache failed', err);
  }
}

export async function loadZonesCache() {
  try {
    const raw = await AsyncStorage.getItem(KEY_ZONES);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

export async function loadStatsCache() {
  try {
    const [[, statsRaw], [, atRaw]] = await AsyncStorage.multiGet([
      KEY_STATS,
      KEY_STATS_AT,
    ]);
    return {
      stats: statsRaw ? JSON.parse(statsRaw) : null,
      updatedAt: atRaw ? Number(atRaw) : null,
    };
  } catch (err) {
    return { stats: null, updatedAt: null };
  }
}
