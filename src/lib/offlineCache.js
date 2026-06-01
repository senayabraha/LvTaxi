import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_ZONES = 'lvtaxi:cache:zones:v1';
const KEY_STATS = 'lvtaxi:cache:zone_stats:v1';
const KEY_STATS_AT = 'lvtaxi:cache:zone_stats:updated_at:v1';
const KEY_PENDING_TRAJECTORIES = 'lvtaxi:pending:trajectories:v1';

// Bounds so a long offline stretch can never bloat AsyncStorage:
//   - keep at most the most recent N pending visit saves
//   - cap points-per-save so one giant trajectory can't dominate storage
const MAX_PENDING_TRAJECTORIES = 20;
const MAX_POINTS_PER_PENDING = 300;

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

// ── Pending trajectory saves (offline resilience) ─────────────────────────────
// If the trajectory write fails at visit exit (e.g. no network), we stash a
// compact, bounded copy here and retry on next launch/reconnect instead of
// silently dropping the visit's GPS history. Storage is deliberately bounded:
// at most MAX_PENDING_TRAJECTORIES saves, each downsampled to
// MAX_POINTS_PER_PENDING points, so this never grows unbounded.

function simplifyPoints(points) {
  if (!Array.isArray(points)) return [];
  if (points.length <= MAX_POINTS_PER_PENDING) return points;
  // Keep first & last, evenly sample the middle so endpoints survive.
  const first = points[0];
  const last = points[points.length - 1];
  const step = points.length / (MAX_POINTS_PER_PENDING - 2);
  const middle = [];
  for (let i = 1; i < MAX_POINTS_PER_PENDING - 1; i++) {
    middle.push(points[Math.min(points.length - 2, Math.floor(i * step))]);
  }
  return [first, ...middle, last];
}

export async function loadPendingTrajectories() {
  try {
    const raw = await AsyncStorage.getItem(KEY_PENDING_TRAJECTORIES);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

export async function savePendingTrajectory(record) {
  if (!record || !record.visit_id) return;
  try {
    const list = await loadPendingTrajectories();
    // De-dupe by visit_id so a repeated failure doesn't pile up duplicates.
    const filtered = list.filter((r) => r.visit_id !== record.visit_id);
    filtered.push({
      visit_id: record.visit_id,
      gps_points: simplifyPoints(record.gps_points),
      features: record.features ?? null,
      ai_classification: record.ai_classification ?? null,
      ai_confidence: record.ai_confidence ?? null,
      queued_at: Date.now(),
    });
    // Keep only the most recent saves.
    const bounded = filtered.slice(-MAX_PENDING_TRAJECTORIES);
    await AsyncStorage.setItem(
      KEY_PENDING_TRAJECTORIES,
      JSON.stringify(bounded)
    );
  } catch (err) {
    console.warn('[offlineCache] savePendingTrajectory failed', err);
  }
}

export async function clearPendingTrajectory(visitId) {
  try {
    const list = await loadPendingTrajectories();
    const filtered = list.filter((r) => r.visit_id !== visitId);
    await AsyncStorage.setItem(
      KEY_PENDING_TRAJECTORIES,
      JSON.stringify(filtered)
    );
  } catch (err) {
    console.warn('[offlineCache] clearPendingTrajectory failed', err);
  }
}
