import { supabase } from '../supabase.js';
import { centroidOf, radiusMeters, normalizeName } from '../geo.js';

// Wraps every Supabase write for zones. Both UploadModal and Builder
// SavePanel go through this. After every write, regenerateSnapshot()
// rewrites zones.geojson in Storage so the DB and the file stay in sync.

export async function saveDrawn({ name, feature }) {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error('Zone name required');
  const center = centroidOf(feature);
  if (!center) throw new Error('Polygon has no usable centroid');
  const radius = radiusMeters(feature);

  const row = {
    name: cleanName,
    lat: center.lat,
    lng: center.lng,
    radius_meters: radius,
    drawn_polygon: feature,
    use_driven_polygon: false,
    active: true,
    visible_to_drivers: true,
    is_coming_soon: false,
  };

  const { data: upserted, error: upErr } = await supabase
    .from('staging_zones')
    .upsert(row, { onConflict: 'name' })
    .select('id, name')
    .single();
  if (upErr) throw upErr;

  await supabase
    .from('zone_stats')
    .upsert(
      {
        zone_id: upserted.id,
        cars_staged: 0,
        flow_rate_per_hour: 0,
        wait_time_minutes: null,
        last_updated: new Date().toISOString(),
      },
      { onConflict: 'zone_id', ignoreDuplicates: true }
    );

  regenerateSnapshot().catch((err) =>
    console.warn('[zoneStore] snapshot regen failed', err)
  );

  return upserted;
}

export async function saveDriven({ name, feature }) {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error('Zone name required');

  const { data: existing, error: lookupErr } = await supabase
    .from('staging_zones')
    .select('id, name')
    .eq('name', cleanName)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!existing) {
    throw new Error(
      `No zone named "${cleanName}". Create it as Drawn first.`
    );
  }

  const { error: updErr } = await supabase
    .from('staging_zones')
    .update({ driven_polygon: feature })
    .eq('id', existing.id);
  if (updErr) throw updErr;

  regenerateSnapshot().catch((err) =>
    console.warn('[zoneStore] snapshot regen failed', err)
  );

  return existing;
}

// Bulk upsert used by UploadModal "Drawn" path.
export async function bulkUpsertDrawn(rows) {
  const payload = rows.map((r) => ({
    name: normalizeName(r.name),
    lat: r.center.lat,
    lng: r.center.lng,
    radius_meters: r.radius,
    drawn_polygon: r.feature,
    use_driven_polygon: false,
    active: true,
    visible_to_drivers: true,
    is_coming_soon: false,
  }));
  const { data: upserted, error } = await supabase
    .from('staging_zones')
    .upsert(payload, { onConflict: 'name' })
    .select('id, name');
  if (error) throw error;

  if (upserted?.length) {
    const statRows = upserted.map((r) => ({
      zone_id: r.id,
      cars_staged: 0,
      flow_rate_per_hour: 0,
      wait_time_minutes: null,
      last_updated: new Date().toISOString(),
    }));
    await supabase
      .from('zone_stats')
      .upsert(statRows, { onConflict: 'zone_id', ignoreDuplicates: true });
  }

  regenerateSnapshot().catch((err) =>
    console.warn('[zoneStore] snapshot regen failed', err)
  );

  return upserted ?? [];
}

// Bulk update used by UploadModal "Driven" path.
export async function bulkUpdateDriven(rows) {
  const toUpdate = rows.filter((r) => r.existing);
  for (const r of toUpdate) {
    const { error } = await supabase
      .from('staging_zones')
      .update({ driven_polygon: r.feature })
      .eq('name', r.name);
    if (error) {
      console.warn('[zoneStore] bulkUpdateDriven failed', r.name, error);
    }
  }

  if (toUpdate.length > 0) {
    regenerateSnapshot().catch((err) =>
      console.warn('[zoneStore] snapshot regen failed', err)
    );
  }

  return toUpdate.length;
}

// Regenerates the canonical zones.geojson in Supabase Storage.
// Best-effort, client-side. If it fails the DB is still authoritative.
export async function regenerateSnapshot() {
  const { data: zones, error } = await supabase
    .from('staging_zones')
    .select('*');
  if (error) throw error;

  const features = (zones ?? [])
    .filter((z) => z.drawn_polygon || z.driven_polygon)
    .map((z) => {
      const f = z.use_driven_polygon && z.driven_polygon
        ? z.driven_polygon
        : z.drawn_polygon;
      return {
        type: 'Feature',
        geometry: f.geometry ?? f,
        properties: {
          ...(f.properties ?? {}),
          id: z.id,
          name: z.name,
          phase: z.use_driven_polygon && z.driven_polygon ? 'B' : 'A',
          is_coming_soon: z.is_coming_soon,
          active: z.active,
        },
      };
    });

  const fc = {
    type: 'FeatureCollection',
    generated_at: new Date().toISOString(),
    features,
  };

  const blob = new Blob([JSON.stringify(fc, null, 2)], {
    type: 'application/geo+json',
  });
  const { error: upErr } = await supabase.storage
    .from('zones-snapshot')
    .upload('zones.geojson', blob, {
      upsert: true,
      contentType: 'application/geo+json',
      cacheControl: '0',
    });
  if (upErr) throw upErr;

  return fc.features.length;
}
