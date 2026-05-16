import { supabase } from './supabase';
import { extractFeatures } from './trajectoryRecorder';
import { classifyVisit, VISIT_CLASS } from './behavioralClassifier';
import { decrementZoneCount } from './zoneStatsEngine';
import { sendStagingConfirmation } from './notificationService';

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

async function upsertHistory(driverId, zoneId, deltas) {
  if (!driverId || !zoneId) return;
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
  if (error) console.warn('[visitProcessor] history upsert failed', error);
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

async function saveClassification(visitId, classification, confidence, score) {
  const { error } = await supabase
    .from('zone_visits')
    .update({
      classification,
      confidence_score: confidence,
    })
    .eq('id', visitId);
  if (error) console.warn('[visitProcessor] saveClassification failed', error);

  await supabase
    .from('trajectories')
    .update({ ai_classification: classification, ai_confidence: confidence })
    .eq('visit_id', visitId);
}

export async function saveTrainingData(visitId, confirmedLabel, extra = {}) {
  const visit = await fetchVisit(visitId);
  if (!visit) return;

  const { error: visitErr } = await supabase
    .from('zone_visits')
    .update({ driver_confirmed: true, confirmed_label: confirmedLabel })
    .eq('id', visitId);
  if (visitErr) console.warn('[visitProcessor] visit confirm failed', visitErr);

  const { error: trajErr } = await supabase
    .from('trajectories')
    .update({ ground_truth: confirmedLabel })
    .eq('visit_id', visitId);
  if (trajErr) console.warn('[visitProcessor] trajectory ground truth failed', trajErr);

  const enteredAt = visit.entered_at ? new Date(visit.entered_at) : new Date();
  console.log('[visitProcessor] training data saved', {
    visitId,
    driverId: visit.driver_id,
    zoneId: visit.zone_id,
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

  await decrementZoneCount(zoneId);
  await upsertHistory(driverId, zoneId, {
    total_visits: 1,
    staging_count: 1,
  });

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

  await upsertHistory(driverId, zoneId, {
    total_visits: 1,
    dropoff_count: 1,
  });

  if (opts.confirmed) {
    await saveTrainingData(visitId, VISIT_CLASS.DROP_OFF);
  }
}

export async function processZoneExit(visitId, driverId, zoneId, gpsPoints, zoneCenter = null) {
  const features = extractFeatures(gpsPoints, zoneCenter);
  const history = await loadDriverHistory(driverId, zoneId);

  const remote = await classifyRemote(features, driverId);
  const { classification, confidence, score } =
    remote ?? classifyVisit(features, history);

  await supabase
    .from('trajectories')
    .upsert(
      {
        visit_id: visitId,
        gps_points: gpsPoints,
        features,
        ai_classification: classification,
        ai_confidence: confidence,
      },
      { onConflict: 'visit_id' }
    );

  await saveClassification(visitId, classification, confidence, score);

  if (classification === VISIT_CLASS.STAGING) {
    await processAsStaging(visitId, { zoneId });
  } else if (
    classification === VISIT_CLASS.DROP_OFF ||
    classification === VISIT_CLASS.PASSING
  ) {
    await processAsDropoff(visitId, { zoneId });
  } else {
    const zoneName = await fetchZoneName(zoneId);
    try {
      await sendStagingConfirmation(driverId, zoneName, visitId, zoneId);
    } catch (err) {
      console.warn('[visitProcessor] confirmation push failed', err);
    }
  }

  return { classification, confidence, score, features };
}
