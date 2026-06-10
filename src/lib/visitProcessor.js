import { supabase } from './supabase';
import { extractFeatures } from './trajectoryRecorder';
import { classifyVisit, VISIT_CLASS } from './behavioralClassifier';
import { clearDriverPresence, recordLoadEvent } from './zoneStatsEngine';
import { sendStagingConfirmation } from './notificationService';
import { recordTrajectoryFlush } from './locationWritePolicy';
import {
  savePendingTrajectory,
  loadPendingTrajectories,
  clearPendingTrajectory,
  savePendingVisitSideEffect,
  loadPendingVisitSideEffects,
  clearPendingVisitSideEffect,
  bumpVisitSideEffectAttempt,
} from './offlineCache';

// Side-effect queue types. Each is a compact, replayable post-visit write that
// must survive an offline exit. NONE of these carry raw GPS arrays — those live
// only in the pending-trajectory queue.
const SIDE_EFFECT = {
  SAVE_CLASSIFICATION: 'SAVE_CLASSIFICATION',
  RECORD_LOAD_EVENT: 'RECORD_LOAD_EVENT',
  UPSERT_DRIVER_HISTORY: 'UPSERT_DRIVER_HISTORY',
  SAVE_TRAINING_DATA: 'SAVE_TRAINING_DATA',
};

// True when an RPC error means the function isn't deployed yet (so we can fall
// back to the legacy per-table writes until migration 013 is applied).
function isMissingFunctionError(error) {
  if (!error) return false;
  if (error.code === 'PGRST202') return true;
  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('could not find the function') ||
    msg.includes('schema cache') ||
    (msg.includes('function') && msg.includes('does not exist'))
  );
}

// Atomically finalize a visit's classification: writes the trajectories row
// (gps_points/features/ai_classification/ai_confidence) AND zone_visits
// (classification/confidence_score) in ONE transaction via the
// finalize_visit_classification RPC (migration 013). Because both writes share
// a transaction, the two tables can never be momentarily out of sync.
//
//   - Success                     → done, both tables consistent.
//   - RPC not deployed (pre-013)  → fall back to the legacy two-write path so
//                                   the app keeps working before the migration.
//   - Genuine failure (offline)   → queue ONE pending trajectory row; its replay
//                                   restores BOTH tables together (no divergence).
//
// Returns { ok, warnings }.
async function finalizeVisitClassification({
  visitId,
  gpsPoints,
  features,
  classification,
  confidence,
}) {
  const row = {
    visit_id: visitId,
    gps_points: gpsPoints,
    features,
    ai_classification: classification,
    ai_confidence: confidence,
  };

  const { error } = await supabase.rpc('finalize_visit_classification', {
    p_visit_id: visitId,
    p_gps_points: gpsPoints,
    p_features: features,
    p_classification: classification,
    p_confidence: confidence,
  });

  if (!error) {
    recordTrajectoryFlush();
    return { ok: true, warnings: [] };
  }

  // Migration 013 not applied yet — fall back to the legacy per-table writes.
  if (isMissingFunctionError(error)) {
    const warnings = [];
    if (!(await persistTrajectorySafe(row))) warnings.push('trajectory');
    if (!(await saveClassificationSafe({ visitId, classification, confidence })))
      warnings.push('classification');
    return { ok: warnings.length === 0, warnings };
  }

  // Offline / transient: queue the combined row so a single atomic replay
  // restores both tables together.
  console.warn(
    '[visitProcessor] finalize_visit_classification failed, queuing',
    error
  );
  await savePendingTrajectory(row);
  return { ok: false, warnings: ['finalize'] };
}

// Persist one trajectory row for a visit (one visit = one write — never one
// write per GPS point). On failure (e.g. offline) the row is queued to
// AsyncStorage and retried later. Returns true on a successful Supabase write.
//
// persistTrajectorySafe owns the trajectories row, including ai_classification
// and ai_confidence. saveClassificationSafe owns only zone_visits classification.
// In the normal path both are written atomically by finalizeVisitClassification;
// these two wrappers are the pre-013 fallback. Do not duplicate trajectory
// classification writes.
async function persistTrajectorySafe(row) {
  const { error } = await supabase
    .from('trajectories')
    .upsert(row, { onConflict: 'visit_id' });
  if (error) {
    console.warn('[visitProcessor] trajectory persist failed, queuing', error);
    await savePendingTrajectory(row);
    return false;
  }
  recordTrajectoryFlush();
  return true;
}

// Replay one queued trajectory. Prefers the atomic RPC so zone_visits
// classification is restored together with the trajectory row; falls back to a
// sequential trajectory-upsert + zone_visits-update if the RPC isn't deployed.
// Returns true only if the visit is fully restored.
async function replayPendingTrajectory(row) {
  if (row.ai_classification != null) {
    const { error } = await supabase.rpc('finalize_visit_classification', {
      p_visit_id: row.visit_id,
      p_gps_points: row.gps_points,
      p_features: row.features,
      p_classification: row.ai_classification,
      p_confidence: row.ai_confidence,
    });
    if (!error) return true;
    if (!isMissingFunctionError(error)) {
      console.warn('[visitProcessor] pending trajectory RPC retry failed', error);
      return false;
    }
    // else: RPC absent → fall through to legacy sequential restore.
  }

  const { error: tErr } = await supabase
    .from('trajectories')
    .upsert(
      {
        visit_id: row.visit_id,
        gps_points: row.gps_points,
        features: row.features,
        ai_classification: row.ai_classification,
        ai_confidence: row.ai_confidence,
      },
      { onConflict: 'visit_id' }
    );
  if (tErr) {
    console.warn('[visitProcessor] pending trajectory retry failed', tErr);
    return false;
  }
  // Keep zone_visits in step even without the RPC.
  if (row.ai_classification != null) {
    const { error: zErr } = await supabase
      .from('zone_visits')
      .update({
        classification: row.ai_classification,
        confidence_score: row.ai_confidence,
      })
      .eq('id', row.visit_id);
    if (zErr) {
      console.warn('[visitProcessor] pending zone_visit retry failed', zErr);
      return false;
    }
  }
  return true;
}

// Retry any trajectory saves that were queued while offline. Safe to call on
// app launch and on reconnect — each successful replay is dequeued. Stops early
// on the first still-failing write so we never hammer an offline backend.
// Returns { saved, failed } for dev diagnostics.
export async function retryPendingTrajectories() {
  const pending = await loadPendingTrajectories();
  let saved = 0;
  let failed = 0;
  if (!pending.length) return { saved, failed };
  for (const row of pending) {
    const ok = await replayPendingTrajectory(row);
    if (ok) {
      recordTrajectoryFlush();
      await clearPendingTrajectory(row.visit_id);
      saved += 1;
    } else {
      failed += 1;
      break;
    }
  }
  return { saved, failed };
}

async function classifyRemote(features, driverId) {
  try {
    const { data, error } = await supabase.functions.invoke(
      'classify-trajectory',
      { body: { features, driverId } }
    );
    if (error || !data?.classification) return null;
    return {
      classification: data.classification,
      confidence: Math.round((data.confidence ?? 0.5) * 100),
      score: data.score,
      source: data.source ?? 'model',
    };
  } catch (err) {
    console.warn('[visitProcessor] remote classify failed', err);
    return null;
  }
}

const HISTORY_CAP = 25;

async function loadDriverHistory(driverId, zoneId) {
  if (!driverId || !zoneId) return null;
  const { data, error } = await supabase
    .from('driver_zone_history')
    .select('*')
    .eq('driver_id', driverId)
    .eq('zone_id', zoneId)
    .maybeSingle();
  if (error) {
    console.warn('[visitProcessor] history load failed', error);
    return null;
  }
  return data;
}

function nextHistoryScore(history) {
  const staging = history?.staging_count ?? 0;
  const dropoff = history?.dropoff_count ?? 0;
  const total = staging + dropoff;
  if (total === 0) return 0;
  const ratio = (staging - dropoff) / total;
  return Math.round(ratio * HISTORY_CAP);
}

// Read-modify-write driver history. Returns true on success (or when there is
// nothing to do). Returns false if the upsert failed so callers can queue it.
async function upsertHistory(driverId, zoneId, deltas) {
  if (!driverId || !zoneId) return true;
  const existing = (await loadDriverHistory(driverId, zoneId)) ?? {
    driver_id: driverId,
    zone_id: zoneId,
    total_visits: 0,
    staging_count: 0,
    dropoff_count: 0,
  };
  const merged = {
    driver_id: driverId,
    zone_id: zoneId,
    total_visits: (existing.total_visits ?? 0) + (deltas.total_visits ?? 0),
    staging_count: (existing.staging_count ?? 0) + (deltas.staging_count ?? 0),
    dropoff_count: (existing.dropoff_count ?? 0) + (deltas.dropoff_count ?? 0),
  };
  merged.history_score = nextHistoryScore(merged);

  const { error } = await supabase
    .from('driver_zone_history')
    .upsert(merged, { onConflict: 'driver_id,zone_id' });
  if (error) {
    console.warn('[visitProcessor] history upsert failed', error);
    return false;
  }
  return true;
}

async function fetchVisit(visitId) {
  const { data, error } = await supabase
    .from('zone_visits')
    .select('*')
    .eq('id', visitId)
    .maybeSingle();
  if (error) console.warn('[visitProcessor] fetchVisit failed', error);
  return data ?? null;
}

async function fetchZoneName(zoneId) {
  if (!zoneId) return 'this zone';
  const { data } = await supabase
    .from('staging_zones')
    .select('name')
    .eq('id', zoneId)
    .maybeSingle();
  return data?.name ?? 'this zone';
}

// Classification write: updates ONLY zone_visits. The trajectories row (with
// ai_classification/ai_confidence) is owned by persistTrajectorySafe, so we must
// NOT write trajectories here — doing so duplicated the classification write and
// created duplicate offline replay work in Phase 2.1.
async function doSaveClassification(visitId, classification, confidence) {
  const { error } = await supabase
    .from('zone_visits')
    .update({
      classification,
      confidence_score: confidence,
    })
    .eq('id', visitId);
  if (error) {
    console.warn('[visitProcessor] saveClassification failed', error);
    return false;
  }
  return true;
}

// ── Safe side-effect wrappers ─────────────────────────────────────────────────
// Each attempts its write once; on failure it queues a compact, replayable
// record instead of throwing. They never increase write frequency — they just
// make the existing per-visit writes recoverable after an offline exit.

async function saveClassificationSafe({ visitId, classification, confidence }) {
  const ok = await doSaveClassification(visitId, classification, confidence);
  if (!ok) {
    await savePendingVisitSideEffect({
      id: `${SIDE_EFFECT.SAVE_CLASSIFICATION}:${visitId}`,
      type: SIDE_EFFECT.SAVE_CLASSIFICATION,
      visit_id: visitId,
      payload: { classification, confidence },
    });
  }
  return ok;
}

async function recordLoadEventSafe(zoneId, visitId) {
  if (!zoneId) return true;
  const { error } = await recordLoadEvent(zoneId);
  if (error) {
    await savePendingVisitSideEffect({
      id: `${SIDE_EFFECT.RECORD_LOAD_EVENT}:${visitId}:${zoneId}`,
      type: SIDE_EFFECT.RECORD_LOAD_EVENT,
      visit_id: visitId,
      zone_id: zoneId,
    });
    return false;
  }
  return true;
}

async function upsertHistorySafe(driverId, zoneId, deltas, visitId) {
  const ok = await upsertHistory(driverId, zoneId, deltas);
  if (!ok) {
    await savePendingVisitSideEffect({
      id: `${SIDE_EFFECT.UPSERT_DRIVER_HISTORY}:${visitId}:${zoneId}`,
      type: SIDE_EFFECT.UPSERT_DRIVER_HISTORY,
      visit_id: visitId,
      driver_id: driverId,
      zone_id: zoneId,
      payload: deltas,
    });
  }
  return ok;
}

async function doSaveTrainingData(visitId, confirmedLabel) {
  if (!visitId || !confirmedLabel) return true;

  const { error: visitErr } = await supabase
    .from('zone_visits')
    .update({ driver_confirmed: true, confirmed_label: confirmedLabel })
    .eq('id', visitId);
  if (visitErr) {
    console.warn('[visitProcessor] visit confirm failed', visitErr);
    return false;
  }

  const { error: trajErr } = await supabase
    .from('trajectories')
    .update({ ground_truth: confirmedLabel })
    .eq('visit_id', visitId);
  if (trajErr) {
    console.warn('[visitProcessor] trajectory ground truth failed', trajErr);
    return false;
  }

  return true;
}

async function saveTrainingDataSafe({ visitId, confirmedLabel, extra }) {
  const ok = await doSaveTrainingData(visitId, confirmedLabel);
  if (!ok) {
    await savePendingVisitSideEffect({
      id: `${SIDE_EFFECT.SAVE_TRAINING_DATA}:${visitId}:${confirmedLabel}`,
      type: SIDE_EFFECT.SAVE_TRAINING_DATA,
      visit_id: visitId,
      payload: { confirmedLabel, extra: extra ?? {} },
    });
  }
  return ok;
}

// Presence clear is intentionally NOT queued: a stale queued clear could later
// drop a driver who has since legitimately re-staged. If the immediate clear
// fails we rely on the 90-second presence TTL to expire the row instead.
async function clearPresenceSafe(driverId) {
  if (!driverId) return true;
  const { error } = await clearDriverPresence(driverId);
  if (error) {
    console.warn(
      '[visitProcessor] clearDriverPresence failed — relying on 90s TTL',
      error
    );
    return false;
  }
  return true;
}

// Shared side-effect bundles so the auto-exit path and the manual confirmation
// path stay consistent. These do NOT re-fetch the visit (which would fail
// offline) — the caller already has driverId/zoneId.
async function applyStagingSideEffects(visitId, driverId, zoneId) {
  await recordLoadEventSafe(zoneId, visitId);
  await upsertHistorySafe(
    driverId,
    zoneId,
    { total_visits: 1, staging_count: 1 },
    visitId
  );
}

async function applyDropoffSideEffects(visitId, driverId, zoneId) {
  await upsertHistorySafe(
    driverId,
    zoneId,
    { total_visits: 1, dropoff_count: 1 },
    visitId
  );
}

// ── Side-effect replay ────────────────────────────────────────────────────────

async function replaySideEffect(rec) {
  switch (rec.type) {
    case SIDE_EFFECT.SAVE_CLASSIFICATION:
      return doSaveClassification(
        rec.visit_id,
        rec.payload?.classification,
        rec.payload?.confidence
      );
    case SIDE_EFFECT.RECORD_LOAD_EVENT: {
      const { error } = await recordLoadEvent(rec.zone_id);
      return !error;
    }
    case SIDE_EFFECT.UPSERT_DRIVER_HISTORY:
      return upsertHistory(rec.driver_id, rec.zone_id, rec.payload ?? {});
    case SIDE_EFFECT.SAVE_TRAINING_DATA:
      return doSaveTrainingData(rec.visit_id, rec.payload?.confirmedLabel);
    default:
      // Unknown/legacy type — drop it so it can't wedge the queue.
      return true;
  }
}

// Retry queued post-visit side effects in order. Stops at the first still-failing
// record to avoid hammering an offline backend. Returns { replayed, failed }.
export async function retryPendingVisitSideEffects() {
  const pending = await loadPendingVisitSideEffects();
  let replayed = 0;
  let failed = 0;
  if (!pending.length) return { replayed, failed };
  for (const rec of pending) {
    let ok = false;
    try {
      ok = await replaySideEffect(rec);
    } catch (err) {
      console.warn('[visitProcessor] side-effect replay threw', err);
      ok = false;
    }
    if (ok) {
      await clearPendingVisitSideEffect(rec.id);
      replayed += 1;
    } else {
      await bumpVisitSideEffectAttempt(rec.id);
      failed += 1;
      break;
    }
  }
  return { replayed, failed };
}

export async function saveTrainingData(visitId, confirmedLabel, extra = {}) {
  const ok = await saveTrainingDataSafe({ visitId, confirmedLabel, extra });
  if (!ok) return;

  const visit = await fetchVisit(visitId);
  const enteredAt = visit?.entered_at ? new Date(visit.entered_at) : new Date();
  console.log('[visitProcessor] training data saved', {
    visitId,
    driverId: visit?.driver_id,
    zoneId: visit?.zone_id,
    confirmedLabel,
    timeOfDay: enteredAt.getHours(),
    dayOfWeek: enteredAt.getDay(),
    ...extra,
  });
}

export async function processAsStaging(visitId, opts = {}) {
  const visit = await fetchVisit(visitId);
  if (!visit) return;
  const zoneId = opts.zoneId ?? visit.zone_id;
  const driverId = visit.driver_id;

  await applyStagingSideEffects(visitId, driverId, zoneId);

  const enteredAt = visit.entered_at ? new Date(visit.entered_at) : null;
  const exitedAt = visit.exited_at ? new Date(visit.exited_at) : new Date();
  const waitSeconds = enteredAt
    ? Math.max(0, Math.round((exitedAt - enteredAt) / 1000))
    : null;
  console.log('[visitProcessor] completed staging', {
    visitId,
    driverId,
    zoneId,
    waitSeconds,
  });

  if (opts.confirmed) {
    await saveTrainingData(visitId, VISIT_CLASS.STAGING);
  }
}

export async function processAsDropoff(visitId, opts = {}) {
  const visit = await fetchVisit(visitId);
  if (!visit) return;
  const zoneId = opts.zoneId ?? visit.zone_id;
  const driverId = visit.driver_id;

  await applyDropoffSideEffects(visitId, driverId, zoneId);

  if (opts.confirmed) {
    await saveTrainingData(visitId, VISIT_CLASS.DROP_OFF);
  }
}

export async function processZoneExit(visitId, driverId, zoneId, gpsPoints, zoneCenter = null) {
  const features = extractFeatures(gpsPoints, zoneCenter);
  // Classification is fully offline-safe: remote classify falls back to the
  // local classifier, and a failed history read falls back to null.
  const history = await loadDriverHistory(driverId, zoneId);
  const remote = await classifyRemote(features, driverId);
  const { classification, confidence, score } =
    remote ?? classifyVisit(features, history);

  // Atomic finalize: trajectory row + zone_visits classification are written in
  // a single transaction (RPC), so the two tables can never be momentarily out
  // of sync. clearPresence + the staging/dropoff side effects remain individually
  // safe — one failure can't abort the rest of the exit, and live presence still
  // clears immediately when online (otherwise the 90s TTL handles it).
  const { warnings } = await finalizeVisitClassification({
    visitId,
    gpsPoints,
    features,
    classification,
    confidence,
  });

  if (!(await clearPresenceSafe(driverId))) warnings.push('presence');

  if (classification === VISIT_CLASS.STAGING) {
    await applyStagingSideEffects(visitId, driverId, zoneId);
  } else if (
    classification === VISIT_CLASS.DROP_OFF ||
    classification === VISIT_CLASS.PASSING
  ) {
    await applyDropoffSideEffects(visitId, driverId, zoneId);
  } else {
    const zoneName = await fetchZoneName(zoneId);
    try {
      await sendStagingConfirmation(driverId, zoneName, visitId, zoneId);
    } catch (err) {
      console.warn('[visitProcessor] confirmation push failed', err);
    }
  }

  return { classification, confidence, score, features, warnings };
}
