import { supabase } from './supabase';

const FLOW_WINDOW_MIN = 60;

async function fetchStats(zoneId) {
  const { data, error } = await supabase
    .from('zone_stats')
    .select('*')
    .eq('zone_id', zoneId)
    .maybeSingle();
  if (error) {
    console.warn('[zoneStatsEngine] fetchStats failed', error);
    return null;
  }
  return data;
}

async function upsertStats(zoneId, patch) {
  const payload = {
    zone_id: zoneId,
    last_updated: new Date().toISOString(),
    ...patch,
  };
  const { error } = await supabase
    .from('zone_stats')
    .upsert(payload, { onConflict: 'zone_id' });
  if (error) {
    console.warn('[zoneStatsEngine] upsertStats failed', error);
  }
}

export async function incrementZoneCount(zoneId) {
  const current = await fetchStats(zoneId);
  const next = (current?.cars_staged ?? 0) + 1;
  await upsertStats(zoneId, { cars_staged: next });
  await recalculateWaitTime(zoneId, { cars_staged: next });
  return next;
}

export async function decrementZoneCount(zoneId) {
  const current = await fetchStats(zoneId);
  const next = Math.max(0, (current?.cars_staged ?? 0) - 1);

  const { error: depErr } = await supabase
    .from('zone_departures')
    .insert({ zone_id: zoneId, departed_at: new Date().toISOString() });
  if (depErr && depErr.code !== '42P01') {
    console.warn('[zoneStatsEngine] insert departure failed', depErr);
  }

  const sinceIso = new Date(Date.now() - FLOW_WINDOW_MIN * 60_000).toISOString();
  const { count, error: cntErr } = await supabase
    .from('zone_departures')
    .select('*', { count: 'exact', head: true })
    .eq('zone_id', zoneId)
    .gte('departed_at', sinceIso);

  let flow = current?.flow_rate_per_hour ?? 0;
  if (!cntErr && count != null) {
    flow = count;
  }

  await upsertStats(zoneId, {
    cars_staged: next,
    flow_rate_per_hour: flow,
  });
  await recalculateWaitTime(zoneId, {
    cars_staged: next,
    flow_rate_per_hour: flow,
  });
  return next;
}

export async function recalculateWaitTime(zoneId, override = null) {
  const current = override
    ? { ...(await fetchStats(zoneId)), ...override }
    : await fetchStats(zoneId);

  const cars = current?.cars_staged ?? 0;
  const flow = current?.flow_rate_per_hour ?? 0;

  const waitMinutes = flow > 0 ? (cars / flow) * 60 : cars > 0 ? null : 0;

  await upsertStats(zoneId, { wait_time_minutes: waitMinutes });
  return waitMinutes;
}

export async function getDriverPositionInZone(zoneId, driverEnteredAt) {
  if (!driverEnteredAt) return null;
  const { count, error } = await supabase
    .from('zone_visits')
    .select('*', { count: 'exact', head: true })
    .eq('zone_id', zoneId)
    .is('exited_at', null)
    .lt('entered_at', driverEnteredAt);
  if (error) {
    console.warn('[zoneStatsEngine] getDriverPositionInZone failed', error);
    return null;
  }
  return (count ?? 0) + 1;
}
