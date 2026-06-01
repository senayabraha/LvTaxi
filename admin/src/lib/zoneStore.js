import { supabase } from '../supabase.js';
import { centroidOf, radiusMeters, normalizeName } from '../geo.js';
import { SCALAR_FIELDS, POLYGON_FIELDS } from './zoneVersionDiff.js';

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

// ── Zone config versioning (Phase 2) ────────────────────────────────────────
// Builds a FeatureCollection-like snapshot of the FULL zone config — every
// zone, with its toggles and polygon presence — for the version history.
// Unlike regenerateSnapshot() this keeps all zones (even circle-only ones) so
// a version is a faithful point-in-time record of the whole configuration.
export function buildZoneSnapshot(zones) {
  const features = (zones ?? []).map((z) => {
    const active = z.use_driven_polygon && z.driven_polygon ? z.driven_polygon : z.drawn_polygon;
    return {
      type: 'Feature',
      geometry: active ? active.geometry ?? active : null,
      properties: {
        id: z.id,
        name: z.name,
        active: z.active,
        is_coming_soon: z.is_coming_soon,
        visible_to_drivers: z.visible_to_drivers,
        use_driven_polygon: z.use_driven_polygon,
        circle_enabled: z.circle_enabled,
        has_drawn_polygon: !!z.drawn_polygon,
        has_driven_polygon: !!z.driven_polygon,
        // Full polygon JSON so a version can be faithfully restored later.
        drawn_polygon: z.drawn_polygon ?? null,
        driven_polygon: z.driven_polygon ?? null,
        phase: z.use_driven_polygon && z.driven_polygon ? 'B' : z.drawn_polygon ? 'A' : 'Circle',
        lat: z.lat,
        lng: z.lng,
        radius_meters: z.radius_meters,
      },
    };
  });
  return {
    type: 'FeatureCollection',
    generated_at: new Date().toISOString(),
    feature_count: features.length,
    features,
  };
}

// Saves a new immutable version row. Returns the inserted version.
// Relies on RLS (admins only); no service role involved.
export async function saveZoneVersion(notes) {
  const { data: zones, error } = await supabase.from('staging_zones').select('*');
  if (error) throw error;

  const snapshot = buildZoneSnapshot(zones);
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data, error: insErr } = await supabase
    .from('zone_config_versions')
    .insert({
      snapshot,
      notes: notes?.trim() ? notes.trim() : null,
      published_by: session?.user?.id ?? null,
    })
    .select('id, version_number, published_at, notes')
    .single();
  if (insErr) throw insErr;

  return data;
}

// ── Zone version restore / rollback (Phase 3) ──────────────────────────────
// Applies a precomputed diff (from computeRestoreDiff) to staging_zones.
//
// Safety:
//   • Sequential (not Promise.all) so the audit trail is ordered and a failure
//     stops cleanly without firing further writes.
//   • Returns an honest summary; on failure it reports how many updates/creates
//     had already been applied (the restore is NOT transactional).
//   • Zones present in the DB but absent from the snapshot are never touched.
//
// Audit: each changed field is logged to zone_audit_log. Polygon fields are
// logged as compact summaries (polygon_set / polygon_changed / polygon_missing)
// instead of huge JSON. Created zones log field = 'restored_created'.
function buildRestoreInsertRow(s) {
  const row = {};
  if (s.id) row.id = s.id; // preserve id for stable references / future diffs
  for (const f of SCALAR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(s, f)) row[f] = s[f];
  }
  for (const f of POLYGON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(s, f)) row[f] = s[f] ?? null;
  }
  // Defaults for NOT NULL / expected columns if the snapshot omitted them.
  if (row.active == null) row.active = true;
  if (row.use_driven_polygon == null) row.use_driven_polygon = false;
  if (row.is_coming_soon == null) row.is_coming_soon = false;
  if (row.visible_to_drivers == null) row.visible_to_drivers = true;
  return row;
}

export async function restoreZoneVersion({ version, diff }) {
  const summary = { updated: 0, created: 0, failed: null };

  // 1. Update existing zones (sequentially).
  for (const item of diff.toUpdate) {
    const { current, patch, changes } = item;
    const { error } = await supabase
      .from('staging_zones')
      .update(patch)
      .eq('id', current.id);
    if (error) {
      summary.failed = {
        stage: 'update',
        zone: current.name,
        message: error.message,
        appliedUpdates: summary.updated,
        appliedCreates: summary.created,
      };
      return summary;
    }
    for (const [field, change] of Object.entries(changes)) {
      const isPoly = POLYGON_FIELDS.includes(field);
      writeAuditLog({
        zone_id: current.id,
        zone_name: current.name,
        field,
        old_value: isPoly
          ? change.from === 'present'
            ? 'polygon_present'
            : 'polygon_absent'
          : current[field],
        new_value: isPoly ? `polygon_${change.kind}` : patch[field],
      });
    }
    summary.updated += 1;
  }

  // 2. Create zones that exist in the snapshot but not the DB.
  for (const s of diff.toCreate) {
    const row = buildRestoreInsertRow(s);
    const { data, error } = await supabase
      .from('staging_zones')
      .insert(row)
      .select('id, name')
      .single();
    if (error) {
      summary.failed = {
        stage: 'create',
        zone: s.name,
        message: error.message,
        appliedUpdates: summary.updated,
        appliedCreates: summary.created,
      };
      return summary;
    }
    await supabase.from('zone_stats').upsert(
      {
        zone_id: data.id,
        cars_staged: 0,
        flow_rate_per_hour: 0,
        wait_time_minutes: null,
        last_updated: new Date().toISOString(),
      },
      { onConflict: 'zone_id', ignoreDuplicates: true }
    );
    writeAuditLog({
      zone_id: data.id,
      zone_name: data.name,
      field: 'restored_created',
      old_value: null,
      new_value: 'created',
    });
    summary.created += 1;
  }

  // 3. Regenerate the canonical snapshot so drivers see the restored config.
  try {
    await regenerateSnapshot();
  } catch (err) {
    console.warn('[zoneStore] post-restore snapshot regen failed', err);
  }

  // 4. Preserve history: record that a restore happened (best-effort).
  try {
    await saveZoneVersion(`Restore applied from version #${version.version_number}`);
  } catch (err) {
    console.warn('[zoneStore] post-restore version save failed', err);
  }

  return summary;
}
