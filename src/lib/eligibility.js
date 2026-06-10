// ── Client-side mirror of server eligibility ─────────────────────────────────
// Pure JavaScript counterpart of the eligible_driver_presence view (migration
// 023). The SERVER is authoritative for counting; this mirror lets the client
// explain "you are counted / not counted (why)" without a round-trip, and is the
// unit-test target for the 9-condition rule.
//
// All nine conditions must hold for a driver to be counted in a zone:
//   1 tracking_enabled   2 driver status 'staged'   3 account active
//   4 current_zone_id set 5 classification 'STAGING' 6 fresh ping (TTL)
//   7 accuracy within the (per-zone) ceiling          8 zone has a polygon
//   9 the point is inside that zone's polygon (ST_Contains ↔ booleanPointInPolygon)

import { PRESENCE_TTL_MS, MAX_PRESENCE_ACCURACY_METERS } from './constants';
import { pointInZonePolygon } from './polygonConfirmation';

export function evaluateDriverEligibility({
  presence,
  driver,
  zone,
  now = Date.now(),
} = {}) {
  const reasons = [];

  // 1. tracking enabled
  if (!driver || driver.tracking_enabled === false) reasons.push('tracking_disabled');
  // 2. driver status staged
  if (driver?.status !== 'staged') reasons.push('not_staged');
  // 3. account active (soft-delete check)
  if (driver?.deleted_at) reasons.push('account_inactive');
  // 4. current zone set
  if (!presence?.current_zone_id) reasons.push('no_zone');
  // 5. classification STAGING
  if (presence?.classification !== 'STAGING') reasons.push('not_staging');
  // (defence-in-depth) the presence zone must match the zone being evaluated
  if (zone?.id && presence?.current_zone_id && zone.id !== presence.current_zone_id) {
    reasons.push('zone_mismatch');
  }
  // 6. fresh ping within the TTL
  const pingMs = presence?.last_ping_at ? new Date(presence.last_ping_at).getTime() : null;
  if (pingMs == null || Number.isNaN(pingMs) || now - pingMs > PRESENCE_TTL_MS) {
    reasons.push('stale_ping');
  }
  // 7. accuracy within the per-zone ceiling (global fallback)
  const ceiling = zone?.max_accuracy_meters ?? MAX_PRESENCE_ACCURACY_METERS;
  if (
    presence?.accuracy != null &&
    Number.isFinite(presence.accuracy) &&
    presence.accuracy >= 0 &&
    presence.accuracy > ceiling
  ) {
    reasons.push('accuracy_too_low');
  }
  // 8 + 9. polygon present and contains the point (fail-closed)
  const inside = zone ? pointInZonePolygon(zone, presence?.lat, presence?.lng) : null;
  if (inside === null) reasons.push('no_polygon');
  else if (inside === false) reasons.push('outside_polygon');

  return { eligible: reasons.length === 0, reasons };
}
