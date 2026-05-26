import { supabase } from './supabase';
import { decrementZoneCount } from './zoneStatsEngine';

export async function closeOrphanedVisits(driverId) {
  if (!driverId) return;
  const { data, error } = await supabase
    .from('zone_visits')
    .select('id, zone_id')
    .eq('driver_id', driverId)
    .is('exited_at', null);
  if (error) {
    console.warn('[visitReconciler] fetch orphans failed', error);
    return;
  }
  if (!data || data.length === 0) return;

  const exitedAt = new Date().toISOString();
  for (const row of data) {
    const { error: updateErr } = await supabase
      .from('zone_visits')
      .update({ exited_at: exitedAt, classification: 'ABANDONED' })
      .eq('id', row.id);
    if (updateErr) {
      console.warn('[visitReconciler] close visit failed', updateErr);
      continue;
    }
    await decrementZoneCount(row.zone_id);
  }
  console.log('[visitReconciler] closed', data.length, 'orphaned visits');
}
