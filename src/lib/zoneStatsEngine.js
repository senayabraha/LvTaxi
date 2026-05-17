import { supabase } from './supabase';

// Atomic via Postgres stored procedures. See:
// supabase/migrations/002_zone_improvements.sql

export async function incrementZoneCount(zoneId) {
  const { error } = await supabase.rpc('increment_zone_count', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] increment failed', error);
}

export async function decrementZoneCount(zoneId) {
  const { error } = await supabase.rpc('decrement_zone_count', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] decrement failed', error);
}

export async function recordLoadEvent(zoneId) {
  const { error } = await supabase.rpc('record_load_event', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] record_load_event failed', error);
}

// Kept for HomeScreen — read-only stat fetch (not racy).
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
