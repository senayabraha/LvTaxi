-- ============================================================
-- 20260608211308_fix_validated_presence_search_path.sql
--
-- Fix: upsert_driver_presence_validated() (migration 023) was created with
-- `SET search_path = public`, but on Supabase PostGIS lives in the `extensions`
-- schema. The function CREATEs fine but FAILS AT RUNTIME — its body calls
-- ST_SetSRID / ST_MakePoint / ST_Contains / ST_Area, which aren't on `public`.
-- Result: every validated presence write errors and no driver is ever counted.
--
-- Same root cause as the 022 fix (geometry type / ST_* not found). Forward-fix,
-- append-only: recreate the function with `extensions` on its search_path, and
-- recreate the eligibility view (it also references ST_*) so this migration is
-- self-contained regardless of how 023 landed.
-- ============================================================

-- Session search_path so the view's ST_* references resolve during CREATE.
SET search_path TO public, extensions, pg_catalog;

-- ── Recreate the validated upsert with extensions on its search_path ─────────
CREATE OR REPLACE FUNCTION upsert_driver_presence_validated(
  p_driver_id       uuid,
  p_zone_id         uuid,
  p_classification  text,
  p_lat             double precision,
  p_lng             double precision,
  p_speed           double precision DEFAULT NULL,
  p_accuracy        double precision DEFAULT NULL,
  p_heading         double precision DEFAULT NULL,
  p_visit_id        uuid             DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_req_class  text;
  v_true_zone  uuid;
  v_ceiling    int;
  v_final_zone uuid;
  v_final_cls  text;
  v_ping_at    timestamptz := now();
  v_pt         geometry;
BEGIN
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot upsert presence for another driver';
  END IF;

  v_req_class := upper(coalesce(p_classification, 'ACTIVE'));

  -- Recompute the TRUE zone from the coordinates (do not trust p_zone_id).
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    v_pt := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
    SELECT sz.id, coalesce(sz.max_accuracy_meters, 50)
      INTO v_true_zone, v_ceiling
    FROM staging_zones sz
    WHERE sz.active = true
      AND sz.geom IS NOT NULL
      AND ST_Contains(sz.geom, v_pt)
    ORDER BY ST_Area(sz.geom) ASC   -- smallest containing zone wins on overlap
    LIMIT 1;
  END IF;

  IF v_true_zone IS NOT NULL
     AND (p_accuracy IS NULL OR p_accuracy < 0 OR p_accuracy <= v_ceiling)
  THEN
    v_final_zone := v_true_zone;
    v_final_cls  := 'STAGING';
  ELSIF p_zone_id IS NOT NULL AND v_req_class IN ('STAGING', 'UNKNOWN') THEN
    v_final_zone := p_zone_id;
    v_final_cls  := 'UNKNOWN';
  ELSE
    v_final_zone := NULL;
    v_final_cls  := 'ACTIVE';
  END IF;

  INSERT INTO driver_presence (
    driver_id, current_zone_id, last_ping_at, classification,
    lat, lng, speed, accuracy, heading, active_visit_id, updated_at
  ) VALUES (
    p_driver_id, v_final_zone, v_ping_at, v_final_cls,
    p_lat, p_lng, p_speed, p_accuracy, p_heading, p_visit_id, v_ping_at
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    current_zone_id = EXCLUDED.current_zone_id,
    last_ping_at    = EXCLUDED.last_ping_at,
    classification  = EXCLUDED.classification,
    lat             = EXCLUDED.lat,
    lng             = EXCLUDED.lng,
    speed           = EXCLUDED.speed,
    accuracy        = EXCLUDED.accuracy,
    heading         = EXCLUDED.heading,
    active_visit_id = EXCLUDED.active_visit_id,
    updated_at      = EXCLUDED.updated_at;

  RETURN v_ping_at;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_driver_presence_validated(
  uuid, uuid, text, double precision, double precision,
  double precision, double precision, double precision, uuid
) TO authenticated;

-- ── Recreate the eligibility view (references ST_*) for robustness ────────────
CREATE OR REPLACE VIEW eligible_driver_presence AS
SELECT dp.*
FROM driver_presence dp
JOIN drivers       d  ON d.id  = dp.driver_id
JOIN staging_zones sz ON sz.id = dp.current_zone_id
WHERE d.tracking_enabled = true
  AND d.status = 'staged'
  AND d.deleted_at IS NULL
  AND dp.current_zone_id IS NOT NULL
  AND dp.classification = 'STAGING'
  AND dp.last_ping_at > now() - interval '90 seconds'   -- PRESENCE_TTL_SECONDS
  AND dp.lat IS NOT NULL AND dp.lng IS NOT NULL
  AND (dp.accuracy IS NULL OR dp.accuracy < 0
       OR dp.accuracy <= coalesce(sz.max_accuracy_meters, 50))
  AND sz.geom IS NOT NULL
  AND ST_Contains(sz.geom, ST_SetSRID(ST_MakePoint(dp.lng, dp.lat), 4326));
