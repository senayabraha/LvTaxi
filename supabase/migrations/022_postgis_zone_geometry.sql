-- Fix: set session search_path so geometry type is found
SET search_path TO extensions, public, pg_catalog;

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE staging_zones
  ADD COLUMN IF NOT EXISTS geom geometry(Geometry, 4326);

ALTER TABLE staging_zones
  ADD COLUMN IF NOT EXISTS max_accuracy_meters int;

CREATE OR REPLACE FUNCTION lvtaxi_zone_geom_from_jsonb(p jsonb)
RETURNS geometry
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_geo  jsonb;
  v_geom geometry;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  v_geo  := CASE WHEN p ? 'geometry' THEN p->'geometry' ELSE p END;
  v_geom := ST_SetSRID(ST_GeomFromGeoJSON(v_geo::text), 4326);
  RETURN v_geom;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'lvtaxi_zone_geom_from_jsonb: skipping malformed polygon: %', sqlerrm;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION lvtaxi_sync_zone_geom()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.geom := lvtaxi_zone_geom_from_jsonb(
    CASE WHEN NEW.use_driven_polygon
         THEN NEW.driven_polygon
         ELSE NEW.drawn_polygon
    END
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

UPDATE staging_zones
SET geom = lvtaxi_zone_geom_from_jsonb(
  CASE WHEN use_driven_polygon
       THEN driven_polygon
       ELSE drawn_polygon
  END
)
WHERE geom IS NULL;

CREATE INDEX IF NOT EXISTS idx_staging_zones_geom
  ON staging_zones USING GIST (geom);
