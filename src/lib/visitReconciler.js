import * as Location from 'expo-location';
import { supabase } from './supabase';
import { clearDriverPresence } from './zoneStatsEngine';
import { sendStagingConfirmation } from './notificationService';
import { refreshWorkAreaCache, detectStagingZoneFromPoint } from './workAreaGeometry';

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

  // Resolve the driver's current position so we can decide whether each open
  // visit is genuinely orphaned or still actively in progress (LIFE-9).
  let currentZoneId = null;
  try {
    await refreshWorkAreaCache();
    const pos = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    if (pos?.coords) {
      const zone = detectStagingZoneFromPoint(
        pos.coords.latitude,
        pos.coords.longitude
      );
      currentZoneId = zone?.id ?? null;
    }
  } catch (err) {
    console.warn('[visitReconciler] current-position check failed', err);
  }

  const exitedAt = new Date().toISOString();
  const exitedMs = Date.now();
  let closedCount = 0;
  let preservedCount = 0;

  for (const row of data) {
    // If the driver is still physically in this zone, the visit is live — keep
    // it open so the background task can continue updating it normally.
    if (currentZoneId && currentZoneId === row.zone_id) {
      console.log('[visitReconciler] preserving active visit', row.id, 'driver still in zone', row.zone_id);
      preservedCount++;
      continue;
    }

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
    closedCount++;

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

  // Only clear presence if no visit was preserved (driver is not in any zone).
  // Live counts come from active_driver_presence — no legacy decrement.
  if (preservedCount === 0) {
    await clearDriverPresence(driverId);
  }

  if (closedCount > 0 || preservedCount > 0) {
    console.log('[visitReconciler] closed', closedCount, 'orphaned visits; preserved', preservedCount, 'active');
  }
}
