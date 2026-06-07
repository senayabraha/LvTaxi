// Pure, dependency-free geo helpers. Kept separate from locationEngine.js (which
// pulls in the Redux store, Supabase and Expo) so geometry can be imported by
// lightweight helpers and unit-tested in a plain Node environment.

const EARTH_RADIUS_M = 6371000;

export function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}
