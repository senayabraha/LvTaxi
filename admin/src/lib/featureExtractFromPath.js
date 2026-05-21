// Extracts ML training features from a manually drawn path (array of {lat,lng} points).
// Geometric features (headingChange, positionVariance, forwardCreep) come from the
// drawn vertices. Time-based features use sensible defaults per route type since
// a static drawing has no temporal dimension.

const EARTH_R = 6371000;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Defaults for the 9 time-based features that cannot be derived from a static drawing.
const ROUTE_DEFAULTS = {
  drop_off: {
    dwellTime: 75,
    avgSpeedInZone: 4.0,
    maxSpeedInZone: 8.0,
    timeStationary: 20,
    stopCount: 2,
    entrySpeed: 8.0,
    exitSpeed: 7.0,
    entryAcceleration: -2.5,
    exitAcceleration: 1.5,
  },
  staging: {
    dwellTime: 720,
    avgSpeedInZone: 0.4,
    maxSpeedInZone: 1.5,
    timeStationary: 650,
    stopCount: 1,
    entrySpeed: 3.0,
    exitSpeed: 1.5,
    entryAcceleration: -0.5,
    exitAcceleration: 0.2,
  },
  loop_then_stage: {
    dwellTime: 900,
    avgSpeedInZone: 1.2,
    maxSpeedInZone: 6.0,
    timeStationary: 700,
    stopCount: 2,
    entrySpeed: 6.0,
    exitSpeed: 1.5,
    entryAcceleration: -2.0,
    exitAcceleration: 0.2,
  },
};

/**
 * @param {Array<{lat: number, lng: number}>} points - drawn path vertices
 * @param {{ lat: number, lng: number }} zoneCenter - zone's lat/lng center
 * @param {'drop_off'|'staging'|'loop_then_stage'} routeType
 * @returns {object} all 12 ML features
 */
export function featuresFromPath(points, zoneCenter, routeType) {
  if (!points || points.length < 2) return { ...ROUTE_DEFAULTS[routeType] ?? ROUTE_DEFAULTS.staging, headingChange: 0, positionVariance: 0, forwardCreep: 0 };

  // headingChange: sum of absolute bearing deltas between consecutive segments
  let headingChange = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const bIn  = bearing(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    const bOut = bearing(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
    let diff = Math.abs(bOut - bIn) % 360;
    if (diff > 180) diff = 360 - diff;
    headingChange += diff;
  }

  // positionVariance: mean squared distance from centroid of all vertices
  const meanLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const meanLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const positionVariance =
    points.reduce((s, p) => s + distanceMeters(p.lat, p.lng, meanLat, meanLng) ** 2, 0) /
    points.length;

  // forwardCreep: how much closer to zone center the driver ends up vs where they started
  let forwardCreep = 0;
  if (zoneCenter) {
    const startDist = distanceMeters(points[0].lat, points[0].lng, zoneCenter.lat, zoneCenter.lng);
    const endDist   = distanceMeters(points[points.length - 1].lat, points[points.length - 1].lng, zoneCenter.lat, zoneCenter.lng);
    forwardCreep = startDist - endDist;
  }

  return {
    ...(ROUTE_DEFAULTS[routeType] ?? ROUTE_DEFAULTS.staging),
    headingChange,
    positionVariance,
    forwardCreep,
  };
}
