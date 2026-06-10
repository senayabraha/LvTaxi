import { supabase } from './supabase';

// Mirror of visitProcessor.isMissingFunctionError so calls degrade gracefully
// when a migration has not been applied yet (the app must run either way).
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
  deviceId,
  sessionId,
  appVersion,
  platform,
}) {
  const args = {
    p_driver_id:      driverId,
    p_zone_id:        zoneId ?? null,
    p_classification: classification ?? 'ACTIVE',
    p_lat:            lat ?? null,
    p_lng:            lng ?? null,
    p_speed:          speed ?? null,
    p_accuracy:       accuracy ?? null,
    p_heading:        heading ?? null,
    p_visit_id:       visitId ?? null,
    p_device_id:      deviceId ?? null,
    p_session_id:     sessionId ?? null,
    p_app_version:    appVersion ?? null,
    p_platform:       platform ?? null,
  };

  // Prefer the server-validated RPC (migration 023): it recomputes the true zone
  // via ST_Contains and enforces the accuracy ceiling, so a drifted/spoofed
  // client cannot claim STAGING. Fall back to the legacy upsert only when the
  // validated function isn't deployed yet (app must run pre-migration).
  let { data, error } = await supabase.rpc('upsert_driver_presence_validated', args);
  if (error && isMissingFunctionError(error)) {
    ({ data, error } = await supabase.rpc('upsert_driver_presence', args));
  }
  if (error) console.warn('[zoneStatsEngine] upsertDriverPresence failed', error);
  // data is the last_ping_at timestamptz returned by the RPC (migration 018/023).
  // null means neither RPC was deployed; caller should treat as unconfirmed.
  return { error, lastPingAt: data ?? null };
}

// ── Idempotent open-visit ensurer (Issue 4 / CNT-1) ──────────────────────────
// Both zone-entry detectors and the manual button call this so exactly one open
// zone_visits row exists per driver. Returns the open visit id. Falls back to a
// best-effort single insert if migration 021 isn't applied yet.
export async function ensureOpenVisit(driverId, zoneId) {
  if (!driverId || !zoneId) return { error: 'missing_args', visitId: null };

  const { data, error } = await supabase.rpc('ensure_open_visit', {
    p_driver_id: driverId,
    p_zone_id: zoneId,
  });

  if (error && isMissingFunctionError(error)) {
    // Pre-migration fallback: a single insert (no cross-zone dedupe guarantee).
    const ins = await supabase
      .from('zone_visits')
      .insert({
        driver_id: driverId,
        zone_id: zoneId,
        entered_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (ins.error) {
      console.warn('[zoneStatsEngine] ensureOpenVisit fallback insert failed', ins.error.message);
      return { error: ins.error, visitId: null };
    }
    return { error: null, visitId: ins.data.id };
  }

  if (error) {
    console.warn('[zoneStatsEngine] ensureOpenVisit failed', error.message);
    return { error, visitId: null };
  }
  return { error: null, visitId: data ?? null };
}

export async function clearDriverPresence(driverId) {
  const { error } = await supabase.rpc('clear_driver_presence', {
    p_driver_id: driverId,
  });
  if (error) console.warn('[zoneStatsEngine] clearDriverPresence failed', error);
  return { error };
}

// ── Legacy load event (still used to record zone_departures for flow calc) ───
export async function recordLoadEvent(zoneId) {
  const { error } = await supabase.rpc('record_load_event', {
    p_zone_id: zoneId,
  });
  if (error) console.warn('[zoneStatsEngine] record_load_event failed', error);
  return { error };
}

// ── DEPRECATED — DO NOT CALL FROM APP CODE ───────────────────────────────────
// incrementZoneCount / decrementZoneCount are retained ONLY as backward-compat
// exports. As of the presence-based rework, NO live app flow calls them — live
// counts come exclusively from active_driver_presence via get_zone_live_stats().
// They still poke zone_stats.cars_staged (a legacy display cache that is no
// longer the source of truth).
//
// Do not add new call sites. If you find yourself reaching for these, write a
// driver_presence row via upsertDriverPresence()/clearDriverPresence() instead.

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
