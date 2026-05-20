// Supabase Edge Function: classify-trajectory
// POST /functions/v1/classify-trajectory
// Body: { features: {...}, driverId?: string }
// Response: { classification, confidence, source, score? }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const MIN_TRAINING_SAMPLES = 100;
const TRAINING_SAMPLE_LIMIT = 2000;

const VISIT_CLASS = {
  STAGING: 'staging',
  DROP_OFF: 'drop_off',
  PASSING: 'passing',
  UNKNOWN: 'unknown',
};

const FEATURE_KEYS = [
  'dwellTime',
  'avgSpeedInZone',
  'maxSpeedInZone',
  'timeStationary',
  'positionVariance',
  'headingChange',
  'forwardCreep',
  'stopCount',
  'entrySpeed',
  'exitSpeed',
  'entryAcceleration',
  'exitAcceleration',
];

function ruleBasedClassify(features) {
  const f = features ?? {};
  let score = 0;
  const dwell = f.dwellTime ?? 0;
  if (dwell < 90) score -= 50;
  else if (dwell < 180) score += 0;
  else if (dwell < 600) score += 40;
  else score += 60;

  const avgSpeed = f.avgSpeedInZone ?? 0;
  if (avgSpeed > 10) score -= 80;
  if ((f.stopCount ?? 0) >= 2) score -= 50;
  if (avgSpeed < 3) score += 35;
  if ((f.timeStationary ?? 0) > 120) score += 30;

  if ((f.forwardCreep ?? 0) > 5) score += 40;
  if ((f.positionVariance ?? Infinity) < 5) score += 20;

  const entrySpeed = f.entrySpeed ?? 0;
  if (entrySpeed > 15) score -= 20;
  if ((f.entryAcceleration ?? 0) < -2) score -= 15;
  if (entrySpeed < 8) score += 20;

  const h = new Date().getHours();
  if ((h >= 6 && h < 10) || h >= 20 || h < 2) score += 15;

  let classification;
  if (score >= 70) classification = VISIT_CLASS.STAGING;
  else if (score <= 20)
    classification = avgSpeed > 10 ? VISIT_CLASS.PASSING : VISIT_CLASS.DROP_OFF;
  else classification = VISIT_CLASS.UNKNOWN;

  const confidence =
    classification === VISIT_CLASS.UNKNOWN
      ? 40
      : Math.max(
          50,
          Math.min(99, 50 + Math.abs(score - (classification === VISIT_CLASS.STAGING ? 70 : 20)))
        );
  return { classification, confidence: confidence / 100, source: 'rules', score };
}

function trainModel(samples) {
  // Split STAGING vs non-STAGING (DROP_OFF/PASSING grouped).
  const positives = [];
  const negatives = [];
  for (const s of samples) {
    if (!s.features || !s.ground_truth) continue;
    if (s.ground_truth === VISIT_CLASS.STAGING) positives.push(s.features);
    else negatives.push(s.features);
  }

  const stats = {};
  for (const key of FEATURE_KEYS) {
    const pos = positives.map((f) => Number(f[key]) || 0);
    const neg = negatives.map((f) => Number(f[key]) || 0);
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const variance = (arr, m) =>
      arr.length ? arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length : 1;
    const muPos = mean(pos);
    const muNeg = mean(neg);
    const varPos = Math.max(variance(pos, muPos), 1e-6);
    const varNeg = Math.max(variance(neg, muNeg), 1e-6);
    // Importance ~ Fisher-style separability.
    const importance =
      (muPos - muNeg) ** 2 / (varPos + varNeg);
    stats[key] = { muPos, muNeg, varPos, varNeg, importance };
  }

  const totalImportance = Object.values(stats).reduce(
    (a, s) => a + s.importance,
    0
  );
  if (totalImportance > 0) {
    for (const key of FEATURE_KEYS) {
      stats[key].weight = stats[key].importance / totalImportance;
    }
  } else {
    for (const key of FEATURE_KEYS) stats[key].weight = 1 / FEATURE_KEYS.length;
  }

  const positiveRate = positives.length / Math.max(samples.length, 1);
  return { stats, positiveRate, posN: positives.length, negN: negatives.length };
}

function modelClassify(features, model) {
  // Per-feature: probability density under each class (Gaussian),
  // weighted by feature importance, combined log-odds.
  let logOdds = Math.log(model.positiveRate / Math.max(1 - model.positiveRate, 1e-6));
  for (const key of FEATURE_KEYS) {
    const v = Number(features?.[key] ?? 0);
    const s = model.stats[key];
    if (!s) continue;
    const pPos =
      Math.exp(-((v - s.muPos) ** 2) / (2 * s.varPos)) /
      Math.sqrt(2 * Math.PI * s.varPos);
    const pNeg =
      Math.exp(-((v - s.muNeg) ** 2) / (2 * s.varNeg)) /
      Math.sqrt(2 * Math.PI * s.varNeg);
    const ratio = (pPos + 1e-9) / (pNeg + 1e-9);
    logOdds += s.weight * FEATURE_KEYS.length * Math.log(ratio);
  }
  const prob = 1 / (1 + Math.exp(-logOdds));
  const classification =
    prob >= 0.6
      ? VISIT_CLASS.STAGING
      : prob <= 0.35
      ? (Number(features?.avgSpeedInZone ?? 0) > 10
          ? VISIT_CLASS.PASSING
          : VISIT_CLASS.DROP_OFF)
      : VISIT_CLASS.UNKNOWN;
  const confidence =
    classification === VISIT_CLASS.UNKNOWN
      ? Math.abs(prob - 0.5) * 2
      : classification === VISIT_CLASS.STAGING
      ? prob
      : 1 - prob;
  return {
    classification,
    confidence,
    source: 'model',
    probability: prob,
  };
}

let cachedModel = null;
let cachedAt = 0;
const MODEL_TTL_MS = 5 * 60 * 1000;

async function getModel(supabase) {
  if (cachedModel && Date.now() - cachedAt < MODEL_TTL_MS) return cachedModel;

  const { data, error } = await supabase
    .from('trajectories')
    .select('features, ground_truth')
    .not('ground_truth', 'is', null)
    .limit(TRAINING_SAMPLE_LIMIT);

  if (error || !data || data.length < MIN_TRAINING_SAMPLES) {
    cachedModel = { trained: false, sampleCount: data?.length ?? 0 };
  } else {
    cachedModel = { trained: true, sampleCount: data.length, ...trainModel(data) };
  }
  cachedAt = Date.now();
  return cachedModel;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const secretKey =
      Deno.env.get('SUPABASE_SECRET_KEY') ??
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SERVICE_ROLE_KEY') ??
      '';
    const supabase = createClient(supabaseUrl, secretKey);

    const { features } = await req.json();
    if (!features) {
      return new Response(JSON.stringify({ error: 'missing features' }), {
        status: 400,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      });
    }

    const model = await getModel(supabase);
    const result = model.trained
      ? modelClassify(features, model)
      : ruleBasedClassify(features);

    return new Response(
      JSON.stringify({ ...result, sampleCount: model.sampleCount ?? 0 }),
      { headers: { ...corsHeaders, 'content-type': 'application/json' } }
    );
  } catch (err) {
    console.error('classify-trajectory failed', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
      }
    );
  }
});
