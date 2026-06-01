import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_ZONES = 'lvtaxi:cache:zones:v1';
const KEY_STATS = 'lvtaxi:cache:zone_stats:v1';
const KEY_STATS_AT = 'lvtaxi:cache:zone_stats:updated_at:v1';
const KEY_PENDING_TRAJECTORIES = 'lvtaxi:pending:trajectories:v1';
const KEY_PENDING_SIDE_EFFECTS = 'lvtaxi:pending:visit_side_effects:v1';

// Bounds so a long offline stretch can never bloat AsyncStorage:
//   - keep at most the most recent N pending visit saves
//   - cap points-per-save so one giant trajectory can't dominate storage
const MAX_PENDING_TRAJECTORIES = 20;
const MAX_POINTS_PER_PENDING = 300;
// Post-visit side effects are tiny (no GPS arrays), so we can keep more of them.
const MAX_PENDING_SIDE_EFFECTS = 50;

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

// ── Pending post-visit side effects (offline resilience) ──────────────────────
// Compact, replayable records for the non-trajectory writes that happen after a
// visit (classification, load event, driver history). These are tiny — they must
// NEVER carry raw GPS arrays (those live only in the pending-trajectory queue).
// De-duped by a stable `id` and bounded to MAX_PENDING_SIDE_EFFECTS.

export async function loadPendingVisitSideEffects() {
  try {
    const raw = await AsyncStorage.getItem(KEY_PENDING_SIDE_EFFECTS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

export async function savePendingVisitSideEffect(record) {
  if (!record || !record.id || !record.type) return;
  return savePendingVisitSideEffects([record]);
}

// Batch insert/replace. Each record is de-duped by id (latest wins) and the
// queue is trimmed to the most recent MAX_PENDING_SIDE_EFFECTS entries.
export async function savePendingVisitSideEffects(records) {
  if (!Array.isArray(records) || records.length === 0) return;
  try {
    const list = await loadPendingVisitSideEffects();
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const record of records) {
      if (!record || !record.id || !record.type) continue;
      const prev = byId.get(record.id);
      byId.set(record.id, {
        id: record.id,
        type: record.type,
        visit_id: record.visit_id ?? null,
        driver_id: record.driver_id ?? null,
        zone_id: record.zone_id ?? null,
        // payload must stay compact — no GPS point arrays here.
        payload: record.payload ?? null,
        queued_at: prev?.queued_at ?? Date.now(),
        attempts: prev?.attempts ?? 0,
      });
    }
    const bounded = Array.from(byId.values()).slice(-MAX_PENDING_SIDE_EFFECTS);
    await AsyncStorage.setItem(
      KEY_PENDING_SIDE_EFFECTS,
      JSON.stringify(bounded)
    );
  } catch (err) {
    console.warn('[offlineCache] savePendingVisitSideEffect failed', err);
  }
}

export async function clearPendingVisitSideEffect(id) {
  try {
    const list = await loadPendingVisitSideEffects();
    const filtered = list.filter((r) => r.id !== id);
    await AsyncStorage.setItem(
      KEY_PENDING_SIDE_EFFECTS,
      JSON.stringify(filtered)
    );
  } catch (err) {
    console.warn('[offlineCache] clearPendingVisitSideEffect failed', err);
  }
}

// Bump the attempt counter for a record that failed to replay (kept bounded).
export async function bumpVisitSideEffectAttempt(id) {
  try {
    const list = await loadPendingVisitSideEffects();
    let changed = false;
    const next = list.map((r) => {
      if (r.id !== id) return r;
      changed = true;
      return { ...r, attempts: (r.attempts ?? 0) + 1 };
    });
    if (changed) {
      await AsyncStorage.setItem(KEY_PENDING_SIDE_EFFECTS, JSON.stringify(next));
    }
  } catch (err) {
    console.warn('[offlineCache] bumpVisitSideEffectAttempt failed', err);
  }
}
