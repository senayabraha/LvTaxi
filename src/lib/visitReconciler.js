import { supabase } from './supabase';
import { clearDriverPresence } from './zoneStatsEngine';

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
  }

  // Live counts come from active_driver_presence — no legacy decrement.
  // These visits were abandoned (e.g. app killed in a zone), so clear this
  // driver's stale presence row rather than touching legacy counters.
  await clearDriverPresence(driverId);

  console.log('[visitReconciler] closed', data.length, 'orphaned visits');
}
