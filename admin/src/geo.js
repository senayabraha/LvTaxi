// Polygon utilities — inlined so we don't ship @turf/turf in the admin bundle.

function polygonCoords(feature) {
  const g = feature?.geometry;
  if (!g || g.type !== 'Polygon') return null;
  return g.coordinates?.[0] ?? null;
}

export function centroidOf(feature) {
  const ring = polygonCoords(feature);
  if (!ring || ring.length < 3) return null;
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  return { lat: y / ring.length, lng: x / ring.length };
}

const EARTH_R = 6371000;
function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function radiusMeters(feature) {
  const ring = polygonCoords(feature);
  if (!ring || ring.length < 3) return 50;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  const diag = distanceMeters(minLat, minLng, maxLat, maxLng);
  return Math.max(40, Math.ceil(diag / 2) + 5);
}

export function normalizeName(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed === 'Shara Hotel') return 'Sahara';
  return trimmed;
}
