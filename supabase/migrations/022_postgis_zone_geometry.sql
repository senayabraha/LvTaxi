-- ============================================================
-- 022_postgis_zone_geometry.sql   (Issue 5 / SEC-3 — part 1: spatial backend)
--
-- Enables PostGIS and gives staging_zones a real geometry column so the backend
-- can decide, with ST_Contains, whether a driver's stored coordinates are
-- genuinely inside a zone — instead of trusting the client's claimed zone.
--
-- Append-only + non-destructive: adds columns/extension/index/trigger only.
-- Backfill is resilient (malformed GeoJSON → NULL geom, never a failed migration).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- Generic geometry (Polygon or MultiPolygon) in WGS84. Generic rather than
-- (Polygon,4326) so a driven MultiPolygon can't fail the migration; ST_Contains
-- works on either.
ALTER TABLE staging_zones
  ADD COLUMN IF NOT EXISTS geom geometry(Geometry, 4326);

-- Per-zone GPS-accuracy ceiling (metres). NULL → fall back to the global
-- MAX_PRESENCE_ACCURACY_METERS (50) mirrored in src/lib/constants.js. Airport
-- lanes can tighten this; large lots can relax it (fuller per-zone rule set in
-- Issue 11).
ALTER TABLE staging_zones
  ADD COLUMN IF NOT EXISTS max_accuracy_meters int;

-- Resilient GeoJSON → geometry: accepts a GeoJSON Feature or a bare geometry
-- (both are stored in the drawn_/driven_polygon jsonb) and returns NULL on any
-- parse error so a single malformed polygon never aborts the backfill/trigger.
CREATE OR REPLACE FUNCTION lvtaxi_zone_geom_from_jsonb(p jsonb)
RETURNS geometry
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_geo jsonb;
  v_geom geometry;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  -- Unwrap a Feature to its geometry; a bare geometry is used as-is.
  v_geo := CASE WHEN p ? 'geometry' THEN p->'geometry' ELSE p END;
  v_geom := ST_SetSRID(ST_GeomFromGeoJSON(v_geo::text), 4326);
  RETURN v_geom;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'lvtaxi_zone_geom_from_jsonb: skipping malformed polygon: %', sqlerrm;
  RETURN NULL;
END;
$$;

-- Keep geom in sync with whichever polygon the zone uses, on insert/update.
CREATE OR REPLACE FUNCTION lvtaxi_sync_zone_geom()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.geom := lvtaxi_zone_geom_from_jsonb(
    CASE WHEN NEW.use_driven_polygon THEN NEW.driven_polygon ELSE NEW.drawn_polygon END
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_zone_geom ON staging_zones;
CREATE TRIGGER trg_sync_zone_geom
  BEFORE INSERT OR UPDATE OF drawn_polygon, driven_polygon, use_driven_polygon
  ON staging_zones
  FOR EACH ROW
  EXECUTE FUNCTION lvtaxi_sync_zone_geom();

-- Backfill existing rows.
UPDATE staging_zones
SET geom = lvtaxi_zone_geom_from_jsonb(
  CASE WHEN use_driven_polygon THEN driven_polygon ELSE drawn_polygon END
)
WHERE geom IS NULL;

-- Spatial index for ST_Contains lookups.
CREATE INDEX IF NOT EXISTS idx_staging_zones_geom
  ON staging_zones USING GIST (geom);
