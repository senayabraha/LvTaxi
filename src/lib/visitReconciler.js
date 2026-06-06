import { supabase } from './supabase';
import { clearDriverPresence } from './zoneStatsEngine';
import { sendStagingConfirmation } from './notificationService';

// Dwell threshold above which an abandoned visit is ambiguous enough to
// warrant asking the driver whether they were staged. Below this the visit
// was too short to be staging — mark it drop_off silently.
const AMBIGUOUS_DWELL_SECONDS = 120;

export async function closeOrphanedVisits(driverId) {
  if (!driverId) return;
  const { data, error } = await supabase
    .from('zone_visits')
    .select('id, zone_id, entered_at')
    .eq('driver_id', driverId)
    .is('exited_at', null);
  if (error) {
    console.warn('[visitReconciler] fetch orphans failed', error);
    return;
  }
  if (!data || data.length === 0) return;

  const exitedAt = new Date().toISOString();
  const exitedMs = Date.now();

  for (const row of data) {
    const enteredMs = row.entered_at ? new Date(row.entered_at).getTime() : null;
    const dwellSeconds = enteredMs
      ? Math.round((exitedMs - enteredMs) / 1000)
      : null;

    const isAmbiguous =
      dwellSeconds != null && dwellSeconds >= AMBIGUOUS_DWELL_SECONDS;

    const { error: updateErr } = await supabase
      .from('zone_visits')
      .update({
        exited_at: exitedAt,
        dwell_seconds: dwellSeconds,
        // Mark ABANDONED so the data pipeline knows GPS data is missing.
        // A driver confirmation (YES/NO push) may later overwrite this to
        // 'staging' or 'drop_off' via saveTrainingData.
        classification: 'ABANDONED',
      })
      .eq('id', row.id);
    if (updateErr) {
      console.warn('[visitReconciler] close visit failed', updateErr);
      continue;
    }

    // For visits long enough to be staging, ask the driver so we can recover
    // a training label even without GPS data.
    if (isAmbiguous) {
      const { data: zoneRow } = await supabase
        .from('staging_zones')
        .select('name')
        .eq('id', row.zone_id)
        .maybeSingle();
      const zoneName = zoneRow?.name ?? 'this zone';
      try {
        await sendStagingConfirmation(driverId, zoneName, row.id, row.zone_id);
      } catch (err) {
        console.warn('[visitReconciler] confirmation push failed', err);
      }
    }
  }

  // Live counts come from active_driver_presence — no legacy decrement.
  await clearDriverPresence(driverId);

  console.log('[visitReconciler] closed', data.length, 'orphaned visits');
}
