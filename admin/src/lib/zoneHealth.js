// Shared zone-health logic so the Live Ops page and the Zones table agree.
//
// Inputs:
//   zone  — a staging_zones row (active, visible_to_drivers, drawn/driven polygon…)
//   stat  — a live-stat row, either from get_zone_live_stats() (rich) or the
//           legacy zone_stats fallback. Field names are read defensively.
//
// Returns: { health: 'GOOD'|'WARNING'|'CRITICAL'|'UNKNOWN', reasons: string[] }

// A stat row is considered stale if its last update is older than this.
export const STALE_MS = 5 * 60 * 1000;

export function isStale(stat) {
  const iso = stat?.last_updated;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t > STALE_MS;
}

// Reads the best available wait estimate from either stat shape.
export function getWaitMinutes(stat) {
  if (!stat) return null;
  if (stat.estimated_wait_minutes != null) return stat.estimated_wait_minutes;
  if (stat.wait_time_minutes != null) return stat.wait_time_minutes;
  return null;
}

export function phaseOf(zone) {
  if (zone.use_driven_polygon && zone.driven_polygon) return 'B';
  if (zone.drawn_polygon) return 'A';
  return 'Circle';
}

export function computeZoneHealth(zone, stat) {
  const reasons = [];

  // A zone that is inactive / coming soon has no live expectations.
  const active = !!zone.active && !zone.is_coming_soon;
  if (!active) {
    return { health: 'UNKNOWN', reasons: ['Zone not active'] };
  }

  const cars = stat?.cars_staged ?? 0;
  const wait = getWaitMinutes(stat);
  const confidence = stat?.wait_confidence ?? null;
  const status = stat?.wait_status ?? null;
  const stale = isStale(stat);

  // ── CRITICAL ────────────────────────────────────────────────────────────
  if (active && !zone.visible_to_drivers) {
    reasons.push('Active but hidden from drivers');
  }
  if (cars > 0 && wait == null) {
    reasons.push('Cars staged but no wait estimate');
  }
  if (stale) {
    reasons.push('Stale data');
  }
  if (reasons.length > 0) {
    return { health: 'CRITICAL', reasons };
  }

  // ── WARNING ───────────────────────────────────────────────────────────────
  if (confidence === 'LOW') reasons.push('Low wait confidence');
  if (status === 'INSUFFICIENT_DATA' || confidence === 'INSUFFICIENT_DATA')
    reasons.push('Insufficient data');
  if (status === 'NO_RECENT_MOVEMENT') reasons.push('No recent movement');
  if (!zone.driven_polygon) reasons.push('No driven polygon');
  if (reasons.length > 0) {
    return { health: 'WARNING', reasons };
  }

  // ── GOOD ────────────────────────────────────────────────────────────────
  if (status === 'OK' && (confidence === 'HIGH' || confidence === 'MEDIUM')) {
    return { health: 'GOOD', reasons: ['OK'] };
  }

  // No rich stat fields available (e.g. legacy fallback with no issues) →
  // we can't positively assert GOOD, so report UNKNOWN.
  return { health: 'UNKNOWN', reasons: ['No live confidence data'] };
}
