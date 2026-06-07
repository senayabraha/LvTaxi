// ── Shared staging-zone confirmation (fail-closed) ───────────────────────────
// Single implementation of "is this point genuinely inside this staging zone?"
// used by BOTH zone-entry paths:
//   • geofenceEngine.verifyWithPolygon (native-circle wake → polygon refine)
//   • ImStagingButton (manual "I'm Staging")
//
// Confirmed staging is the only state counted toward a queue, so this is
// deliberately fail-CLOSED: a zone with a polygon must contain the point, and a
// polygon-check error confirms nothing. Polygon-less zones fall back to a TIGHT
// centre-radius using the zone's actual radius_meters — never a flat 200 m
// (which dwarfs the real 40–80 m lanes and would count drop-offs / passing
// traffic / adjacent valet).

import * as turf from '@turf/turf';
import { getDistanceMeters } from './geoMath';

// Hard ceiling for the polygon-less radius fallback. Even if a zone's
// radius_meters is mis-configured large, confirmed staging never trusts a radius
// wider than this. Documented mirror lives beside the SQL eligibility ceiling.
export const STAGING_FALLBACK_MAX_RADIUS_METERS = 120;
// Used when a polygon-less zone has no usable radius_meters at all.
export const STAGING_FALLBACK_DEFAULT_RADIUS_METERS = 80;

// GeoJSON is stored in jsonb as either a Feature or a bare geometry.
function asPolygonFeature(polygon) {
  if (!polygon) return null;
  return polygon.type === 'Feature' ? polygon : turf.feature(polygon);
}

export function zonePolygon(zone) {
  if (!zone) return null;
  return zone.use_driven_polygon ? zone.driven_polygon : zone.drawn_polygon;
}

export function zoneHasPolygon(zone) {
  return !!zonePolygon(zone);
}

// Low-level point-in-polygon for a zone.
//   true  → inside the polygon
//   false → has a polygon but point is outside, OR the check threw (fail-closed)
//   null  → the zone has no polygon
export function pointInZonePolygon(zone, lat, lng) {
  const polygon = zonePolygon(zone);
  if (!polygon) return null;
  if (lat == null || lng == null) return false;
  try {
    return turf.booleanPointInPolygon(
      turf.point([lng, lat]),
      asPolygonFeature(polygon)
    );
  } catch (err) {
    console.warn('[polygonConfirmation] polygon check failed', err);
    return false; // fail-closed: never count on a malformed polygon
  }
}

function fallbackRadiusMeters(zone) {
  const raw = zone?.radius_meters ?? zone?.radius;
  const r = typeof raw === 'number' && raw > 0 ? raw : STAGING_FALLBACK_DEFAULT_RADIUS_METERS;
  return Math.min(r, STAGING_FALLBACK_MAX_RADIUS_METERS);
}

// High-level confirmation for CONFIRMED STAGING. Returns:
//   { confirmed: boolean, method: 'polygon'|'radius'|'none', reason, distance?, radius? }
export function confirmStagingLocation(zone, lat, lng) {
  if (!zone || lat == null || lng == null) {
    return { confirmed: false, method: 'none', reason: 'missing_input' };
  }

  const inPolygon = pointInZonePolygon(zone, lat, lng);
  if (inPolygon === true) {
    return { confirmed: true, method: 'polygon', reason: 'inside_polygon' };
  }
  if (inPolygon === false) {
    return { confirmed: false, method: 'polygon', reason: 'outside_polygon' };
  }

  // No polygon → tight centre-radius using the zone's real radius.
  if (zone.lat == null || zone.lng == null) {
    return { confirmed: false, method: 'radius', reason: 'no_zone_center' };
  }
  const radius = fallbackRadiusMeters(zone);
  const distance = getDistanceMeters(lat, lng, zone.lat, zone.lng);
  return distance <= radius
    ? { confirmed: true, method: 'radius', reason: 'within_radius', distance, radius }
    : { confirmed: false, method: 'radius', reason: 'outside_radius', distance, radius };
}
