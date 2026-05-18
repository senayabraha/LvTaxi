import { supabase } from '../supabase.js';
import { centroidOf, radiusMeters, normalizeName } from '../geo.js';

// ── Debounced snapshot regeneration ────────────────────────────────────────
// Coalesces rapid toggle changes into a single Storage write.
let _snapTimer = null;
function scheduleSnapshot() {
  clearTimeout(_snapTimer);
  _snapTimer = setTimeout(() => {
    regenerateSnapshot().catch((err) =>
      console.warn('[zoneStore] snapshot regen failed', err)
    );
  }, 800);
}

// ── Audit log (best-effort — fails gracefully if table absent) ──────────────
export async function writeAuditLog({ zone_id, zone_name, field, old_value, new_value }) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  supabase
    .from('zone_audit_log')
    .insert({
      zone_id,
      zone_name,
      field,
      old_value: old_value == null ? null : JSON.stringify(old_value),
      new_value: new_value == null ? null : JSON.stringify(new_value),
      admin_id: session?.user?.id ?? null,
      changed_at: new Date().toISOString(),
    })
    .then(({ error }) => {
      if (error) console.debug('[zoneStore] audit log write skipped:', error.message);
    });
}

// ── Zone field update (used by ZonesPage toggles) ───────────────────────────
export async function updateZoneFields(zone, patch) {
  const { error } = await supabase
    .from('staging_zones')
    .update(patch)
    .eq('id', zone.id);
  if (error) throw error;

  for (const [field, newValue] of Object.entries(patch)) {
    writeAuditLog({
      zone_id: zone.id,
      zone_name: zone.name,
      field,
      old_value: zone[field],
      new_value: newValue,
    });
  }

  scheduleSnapshot();
}

// ── Delete zone ─────────────────────────────────────────────────────────────
export async function deleteZone(id, name) {
  const { error } = await supabase.from('staging_zones').delete().eq('id', id);
  if (error) throw error;

  writeAuditLog({
    zone_id: id,
    zone_name: name ?? id,
    field: 'deleted',
    old_value: 'exists',
    new_value: null,
  });

  scheduleSnapshot();
}

// ── Save drawn polygon (new zone or update existing) ────────────────────────
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

  writeAuditLog({
    zone_id: upserted.id,
    zone_name: cleanName,
    field: 'drawn_polygon',
    old_value: null,
    new_value: 'set',
  });
  scheduleSnapshot();

  return upserted;
}

// ── Save driven polygon (update existing zone only) ─────────────────────────
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

  writeAuditLog({
    zone_id: existing.id,
    zone_name: cleanName,
    field: 'driven_polygon',
    old_value: null,
    new_value: 'set',
  });
  scheduleSnapshot();

  return existing;
}

// ── Bulk upsert drawn polygons (UploadModal Phase A) ────────────────────────
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

  scheduleSnapshot();
  return upserted ?? [];
}

// ── Bulk update driven polygons (UploadModal Phase B) ───────────────────────
export async function bulkUpdateDriven(rows) {
  const toUpdate = rows.filter((r) => r.existing);

  await Promise.all(
    toUpdate.map(async (r) => {
      const { error } = await supabase
        .from('staging_zones')
        .update({ driven_polygon: r.feature })
        .eq('name', r.name);
      if (error) {
        console.warn('[zoneStore] bulkUpdateDriven failed for', r.name, error);
      }
    })
  );

  if (toUpdate.length > 0) scheduleSnapshot();
  return toUpdate.length;
}

// ── Regenerate canonical zones.geojson in Supabase Storage ─────────────────
// Best-effort, client-side. DB is always the source of truth.
export async function regenerateSnapshot() {
  const { data: zones, error } = await supabase
    .from('staging_zones')
    .select('*');
  if (error) throw error;

  const features = (zones ?? [])
    .filter((z) => z.drawn_polygon || z.driven_polygon)
    .map((z) => {
      const f =
        z.use_driven_polygon && z.driven_polygon
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
