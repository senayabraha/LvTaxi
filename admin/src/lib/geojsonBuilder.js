// Client-side GeoJSON import/export helpers for the Builder tab.
//
// Pure-logic module: NO leaflet / turf / supabase / DOM imports at the top
// level, so it can be unit-smoke-tested under plain Node. The only DOM use is
// inside downloadGeoJson(), which is browser-only and never called in tests.
//
// The Builder represents a single editable shape as an ordered list of points
// ({ lat, lng }) plus a mode: 'closed' (polygon) or 'open' (path/buffer).

export const SUPPORTED_TYPES = [
  'FeatureCollection',
  'Feature',
  'Polygon',
  'MultiPolygon',
  'LineString',
  'MultiLineString',
];

const SUPPORTED_GEOMETRY = ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'];
const KNOWN_GEOJSON_TYPES = [...SUPPORTED_TYPES, 'Point', 'MultiPoint', 'GeometryCollection'];

export const ERR = {
  INVALID_JSON: 'This file is not valid JSON.',
  NOT_GEOJSON: 'This file is not valid GeoJSON.',
  UNSUPPORTED: 'This GeoJSON geometry type is not supported yet.',
  EMPTY: 'This GeoJSON does not contain usable coordinates.',
};

// Parse + validate a GeoJSON string. Throws friendly, typed errors.
export function parseGeoJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(ERR.INVALID_JSON);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error(ERR.NOT_GEOJSON);
  }
  if (!KNOWN_GEOJSON_TYPES.includes(parsed.type)) {
    throw new Error(ERR.NOT_GEOJSON);
  }
  // Recognized GeoJSON, but a geometry type the Builder can't edit.
  if (['Point', 'MultiPoint', 'GeometryCollection'].includes(parsed.type)) {
    throw new Error(ERR.UNSUPPORTED);
  }
  return parsed;
}

// Read + parse a File (browser). Validation lives in parseGeoJson.
export async function parseGeoJsonFile(file) {
  if (!file) throw new Error(ERR.INVALID_JSON);
  const text = await file.text();
  return parseGeoJson(text);
}

// Resolve the first geometry the Builder can edit from any supported container.
function firstSupportedGeometry(geojson) {
  if (!geojson || typeof geojson !== 'object') return null;
  if (geojson.type === 'FeatureCollection') {
    const feats = Array.isArray(geojson.features) ? geojson.features : [];
    for (const f of feats) {
      const g = f?.geometry;
      if (g && SUPPORTED_GEOMETRY.includes(g.type)) return g;
    }
    return null;
  }
  if (geojson.type === 'Feature') {
    const g = geojson.geometry;
    return g && SUPPORTED_GEOMETRY.includes(g.type) ? g : null;
  }
  if (SUPPORTED_GEOMETRY.includes(geojson.type)) return geojson;
  return null;
}

function cleanCoords(ring) {
  return (Array.isArray(ring) ? ring : []).filter(
    (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
  );
}

// Convert a parsed GeoJSON object into Builder points + mode.
// Multi-part geometries use their first part (the Builder edits one shape).
// Returns { points: [{ lat, lng }], mode: 'closed' | 'open' }.
export function geoJsonToBuilderPoints(geojson) {
  const geom = firstSupportedGeometry(geojson);
  if (!geom) throw new Error(ERR.UNSUPPORTED);

  let ring;
  let mode;
  switch (geom.type) {
    case 'Polygon':
      ring = geom.coordinates?.[0] ?? [];
      mode = 'closed';
      break;
    case 'MultiPolygon':
      ring = geom.coordinates?.[0]?.[0] ?? [];
      mode = 'closed';
      break;
    case 'LineString':
      ring = geom.coordinates ?? [];
      mode = 'open';
      break;
    case 'MultiLineString':
      ring = geom.coordinates?.[0] ?? [];
      mode = 'open';
      break;
    default:
      throw new Error(ERR.UNSUPPORTED);
  }

  let coords = cleanCoords(ring);
  // Drop the closing duplicate vertex of a polygon ring.
  if (mode === 'closed' && coords.length >= 2) {
    const f = coords[0];
    const l = coords[coords.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) coords = coords.slice(0, -1);
  }
  if (coords.length === 0) throw new Error(ERR.EMPTY);

  const points = coords.map((c) => ({ lat: c[1], lng: c[0] }));
  return { points, mode };
}

// Convert Builder points back into a GeoJSON Feature.
// options: { mode: 'closed'|'open', bufferMeters?, name? }
export function builderPointsToGeoJson(points, options = {}) {
  const { mode = 'open', bufferMeters, name } = options;
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error(ERR.EMPTY);
  }
  const coords = points.map((p) => [p.lng, p.lat]);

  let geometry;
  if (mode === 'closed') {
    if (points.length < 3) throw new Error('A polygon needs at least 3 points.');
    geometry = { type: 'Polygon', coordinates: [[...coords, coords[0]]] };
  } else {
    if (points.length < 2) throw new Error('A path needs at least 2 points.');
    geometry = { type: 'LineString', coordinates: coords };
  }

  const properties = {
    source: 'builder',
    exported_at: new Date().toISOString(),
    geometry_mode: mode === 'closed' ? 'polygon' : 'path',
  };
  if (name) properties.name = name;
  if (mode !== 'closed' && bufferMeters != null) properties.buffer_meters = bufferMeters;

  return { type: 'Feature', geometry, properties };
}

// Bounds as [[south, west], [north, east]] (Leaflet fitBounds order).
// Accepts an array of Builder points OR any GeoJSON object. Returns null if empty.
export function getGeoJsonBounds(input) {
  const lats = [];
  const lngs = [];

  if (Array.isArray(input)) {
    for (const p of input) {
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        lats.push(p.lat);
        lngs.push(p.lng);
      }
    }
  } else if (input && typeof input === 'object') {
    const walk = (c) => {
      if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
        lngs.push(c[0]);
        lats.push(c[1]);
      } else if (Array.isArray(c)) {
        c.forEach(walk);
      }
    };
    const geoms =
      input.type === 'FeatureCollection'
        ? (input.features ?? []).map((f) => f?.geometry)
        : input.type === 'Feature'
        ? [input.geometry]
        : [input];
    geoms.forEach((g) => g?.coordinates && walk(g.coordinates));
  }

  if (lats.length === 0) return null;
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
}

// Clean default filename: lvtaxi-builder-export-YYYY-MM-DD.geojson
export function builderExportFilename(date = new Date()) {
  return `lvtaxi-builder-export-${date.toISOString().slice(0, 10)}.geojson`;
}

// Trigger a browser download of a GeoJSON object (browser-only).
export function downloadGeoJson(geojson, filename) {
  const blob = new Blob([JSON.stringify(geojson, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || builderExportFilename();
  a.click();
  URL.revokeObjectURL(url);
}
