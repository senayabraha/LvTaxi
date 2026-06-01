import { supabase } from './supabase';

// ── Live stats (presence-based) ───────────────────────────────────────────────
// Primary read path for live zone stats. Returns rows with the full shape:
//   { zone_id, cars_staged, flow_rate_per_hour,
//     smoothed_service_rate_per_hour, median_dwell_minutes, dwell_sample_size,
//     estimated_wait_minutes, estimated_wait_min, estimated_wait_max,
//     wait_confidence, wait_status, last_updated }
//
// car counts come from active_driver_presence (90-second TTL), NOT from the
// legacy increment/decrement counters.

export async function fetchLiveZoneStats() {
  const { data, error } = await supabase.rpc('get_zone_live_stats');
  if (error) {
    console.warn('[zoneStatsEngine] fetchLiveZoneStats failed', error);
    return null;
  }
  return data ?? [];
}

// ── Presence upsert ───────────────────────────────────────────────────────────
// Call on every GPS ping while a driver is inside or near a zone.
// classification: 'STAGING' | 'UNKNOWN' | 'PASSING' | 'DROP_OFF' | 'ACTIVE'

export async function upsertDriverPresence({
  driverId,
  zoneId,
  classification,
  lat,
  lng,
  speed,
  accuracy,
  heading,
  visitId,
}) {
  const { error } = await supabase.rpc('upsert_driver_presence', {
    p_driver_id:      driverId,
    p_zone_id:        zoneId ?? null,
    p_classification: classification ?? 'ACTIVE',
    p_lat:            lat ?? null,
    p_lng:            lng ?? null,
    p_speed:          speed ?? null,
    p_accuracy:       accuracy ?? null,
    p_heading:        heading ?? null,
    p_visit_id:       visitId ?? null,
  });
  if (error) console.warn('[zoneStatsEngine] upsertDriverPresence failed', error);
}

export async function clearDriverPresence(driverId) {
  const { error } = await supabase.rpc('clear_driver_presence', {
    p_driver_id: driverId,
  });
  if (error) console.warn('[zoneStatsEngine] clearDriverPresence failed', error);
}

// ── Legacy load event (still used to record zone_departures for flow calc) ───
export async function recordLoadEvent(zoneId) {
  const { error } = await supabase.rpc('record_load_event', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] record_load_event failed', error);
}

// ── Driver queue position ─────────────────────────────────────────────────────
// Read-only — counts open visits entered before driverEnteredAt.

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

// ── DEPRECATED ────────────────────────────────────────────────────────────────
// incrementZoneCount / decrementZoneCount are kept only so existing call
// sites compile without modification. They still update zone_stats.cars_staged
// (the legacy display cache) but that value is no longer the live source of
// truth. Live counts come from active_driver_presence via get_zone_live_stats().
//
// Do not add new call sites. Remove existing ones in a follow-up cleanup.

export async function incrementZoneCount(zoneId) {
  const { error } = await supabase.rpc('increment_zone_count', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] increment failed (deprecated)', error);
}

export async function decrementZoneCount(zoneId) {
  const { error } = await supabase.rpc('decrement_zone_count', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] decrement failed (deprecated)', error);
}
