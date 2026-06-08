-- ============================================================================
-- LvTaxi — manual apply of migrations 019–024
-- Paste this whole script into the Supabase SQL editor and run it once.
--
-- Safe to run on your existing database (001–018 already applied):
--   • 019–023 are the new Phase 0 security + Issues 1–5 changes.
--   • 024 (phase5) is idempotent (IF NOT EXISTS / guarded) — no-ops if present.
-- No destructive statements. 022 needs PostGIS (already available on your project).
--
-- After running, reconcile the integration history so future pushes work:
--   (run separately, only if you use the Supabase CLI linked to the project)
--   supabase migration repair --status applied 019 020 021 022 023 024
-- ============================================================================


-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
-- ▶ 019_lock_down_presence_reads.sql
-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

-- 019_lock_down_presence_reads.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 0 — Security & cheap-correctness hotfix (ship first).
--
-- This migration is append-only and backward compatible. It only tightens
-- read access and refreshes a timestamp; no client signatures change.
--
--   SEC-1  driver_presence is world-readable. Migration 011 created
--          `all_read_presence` (FOR SELECT USING (true)), exposing every
--          driver's live lat/lng/speed/heading to any authenticated user.
--          Fix: drop it. Drivers read only their own row; admins read all.
--          Aggregate counts already come exclusively from the SECURITY DEFINER
--          RPC get_zone_live_stats(), which never returns coordinates.
--
--   SEC-2  get_zone_live_stats() was granted to `anon` in 011/012, letting
--          unauthenticated callers pull operational queue intelligence.
--          Fix: revoke anon EXECUTE. There is no public marketing display, so
--          the RPC stays authenticated-only.
--
--   LIFE-11 clear_driver_presence() never refreshed last_ping_at, so cleared
--          rows look stale in admin/debug views (harmless for counts, since a
--          null zone removes the driver). Fix: set last_ping_at = now().
-- ─────────────────────────────────────────────────────────────────────────────

-- ── SEC-1: lock down driver_presence reads ───────────────────────────────────
DROP POLICY IF EXISTS all_read_presence ON driver_presence;

-- Drivers may read only their own presence row. (The existing
-- `drivers_manage_own_presence` FOR ALL policy already covers this, but we add
-- an explicit SELECT policy so the intent survives any future change to that
-- policy.)
DROP POLICY IF EXISTS drivers_read_own_presence ON driver_presence;
CREATE POLICY drivers_read_own_presence ON driver_presence
  FOR SELECT
  USING (auth.uid() = driver_id);

-- Admins may read all presence rows (used by the admin DriversPage). is_admin()
-- is SECURITY DEFINER + STABLE, so this does not recurse through RLS.
DROP POLICY IF EXISTS admins_read_presence ON driver_presence;
CREATE POLICY admins_read_presence ON driver_presence
  FOR SELECT
  USING (is_admin(auth.uid()));

-- ── SEC-2: get_zone_live_stats() is authenticated-only ───────────────────────
REVOKE EXECUTE ON FUNCTION get_zone_live_stats() FROM anon;

-- ── LIFE-11: clear_driver_presence() refreshes last_ping_at ──────────────────
-- Restated from migration 012 (latest definition), adding last_ping_at = now().
CREATE OR REPLACE FUNCTION clear_driver_presence(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
BEGIN
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot clear presence for another driver';
  END IF;

  UPDATE driver_presence
  SET current_zone_id = NULL,
      classification  = 'ACTIVE',
      last_ping_at    = now(),
      updated_at      = now()
  WHERE driver_id = p_driver_id;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_driver_presence(uuid) TO authenticated;

-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
-- ▶ 020_split_live_counts_staging_vs_unknown.sql
-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

-- ============================================================
-- 020_split_live_counts_staging_vs_unknown.sql   (Issue 2 — CNT-3)
--
-- Problem: get_zone_live_stats() counted classification IN ('STAGING','UNKNOWN')
-- toward cars_staged, but the client predicate countsInStagingMath() counts only
-- confirmed STAGING. Drivers merely *near* a zone (UNKNOWN) inflated the queue.
--
-- Fix: cars_staged now counts ONLY confirmed 'STAGING'. A new nearby_unconfirmed
-- column reports 'UNKNOWN' presence separately. The blended wait model uses the
-- (now STAGING-only) cars_staged, which is the correct queue length.
--
-- Append-only + non-destructive. The return type changes (new column), so the
-- function is dropped and recreated (mirrors migration 018's pattern). EXECUTE is
-- re-granted to authenticated ONLY — anon stays revoked (SEC-2, migration 019).
-- ============================================================

DROP FUNCTION IF EXISTS get_zone_live_stats();

CREATE FUNCTION get_zone_live_stats()
RETURNS TABLE (
  zone_id                       uuid,
  cars_staged                   int,
  nearby_unconfirmed            int,
  flow_rate_per_hour            double precision,
  smoothed_service_rate_per_hour double precision,
  median_dwell_minutes          double precision,
  dwell_sample_size             int,
  estimated_wait_minutes        double precision,
  estimated_wait_min            double precision,
  estimated_wait_max            double precision,
  wait_confidence               text,
  wait_status                   text,
  last_updated                  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ttl interval := interval '90 seconds';
BEGIN
  RETURN QUERY
  WITH

  -- ── Live counts from presence (TTL-gated) ───────────────────────────────
  -- cars_staged counts confirmed STAGING only; nearby_unconfirmed counts
  -- UNKNOWN ("near, not confirmed in the lane"). These mirror the JS helpers
  -- classificationCountsAsStaged / classificationCountsAsNearby in constants.js.
  live_counts AS (
    SELECT
      dp.current_zone_id                                                       AS zone_id,
      COUNT(DISTINCT dp.driver_id) FILTER (WHERE dp.classification = 'STAGING')::int AS cars_staged,
      COUNT(DISTINCT dp.driver_id) FILTER (WHERE dp.classification = 'UNKNOWN')::int AS nearby_unconfirmed
    FROM driver_presence dp
    WHERE dp.last_ping_at > now() - v_ttl
      AND dp.current_zone_id IS NOT NULL
      AND dp.classification IN ('STAGING', 'UNKNOWN')
    GROUP BY dp.current_zone_id
  ),

  dep_15m AS (
    SELECT zone_id, COUNT(*)::double precision * 4 AS rate
    FROM zone_departures
    WHERE departed_at > now() - interval '15 minutes'
    GROUP BY zone_id
  ),
  dep_30m AS (
    SELECT zone_id, COUNT(*)::double precision * 2 AS rate
    FROM zone_departures
    WHERE departed_at > now() - interval '30 minutes'
    GROUP BY zone_id
  ),
  dep_60m AS (
    SELECT zone_id, COUNT(*)::double precision AS rate
    FROM zone_departures
    WHERE departed_at > now() - interval '60 minutes'
    GROUP BY zone_id
  ),
  smoothed_rates AS (
    SELECT
      COALESCE(d15.zone_id, d30.zone_id, d60.zone_id) AS zone_id,
      COALESCE(d15.rate, 0)                             AS rate_15m,
      COALESCE(d30.rate, 0)                             AS rate_30m,
      COALESCE(d60.rate, 0)                             AS rate_60m,
      (  COALESCE(d15.rate, 0) * 0.50
       + COALESCE(d30.rate, 0) * 0.30
       + COALESCE(d60.rate, 0) * 0.20
      )                                                 AS smoothed_rate
    FROM dep_15m d15
    FULL OUTER JOIN dep_30m d30 ON d15.zone_id = d30.zone_id
    FULL OUTER JOIN dep_60m d60 ON COALESCE(d15.zone_id, d30.zone_id) = d60.zone_id
  ),

  dwell_stats AS (
    SELECT
      zv.zone_id,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY zv.dwell_seconds
      ) / 60.0                                          AS median_dwell_minutes,
      COUNT(*)::int                                      AS sample_size
    FROM zone_visits zv
    WHERE zv.exited_at IS NOT NULL
      AND zv.dwell_seconds IS NOT NULL
      AND zv.dwell_seconds BETWEEN 120 AND 7200
      AND lower(zv.classification) = 'staging'
      AND zv.exited_at > now() - interval '60 minutes'
    GROUP BY zv.zone_id
  ),

  legacy_stats AS (
    SELECT zone_id, flow_rate_per_hour
    FROM zone_stats
  ),

  assembled AS (
    SELECT
      sz.id                                                   AS zone_id,
      COALESCE(lc.cars_staged, 0)                            AS cars_staged,
      COALESCE(lc.nearby_unconfirmed, 0)                     AS nearby_unconfirmed,
      COALESCE(ls.flow_rate_per_hour, 0)                     AS flow_rate_per_hour,
      COALESCE(sr.smoothed_rate, 0)                          AS smoothed_rate,
      ds.median_dwell_minutes,
      COALESCE(ds.sample_size, 0)                            AS sample_size,
      now()                                                   AS last_updated
    FROM staging_zones sz
    LEFT JOIN live_counts  lc ON lc.zone_id = sz.id
    LEFT JOIN legacy_stats ls ON ls.zone_id = sz.id
    LEFT JOIN smoothed_rates sr ON sr.zone_id = sz.id
    LEFT JOIN dwell_stats   ds ON ds.zone_id  = sz.id
    WHERE sz.active = true
  ),

  computed AS (
    SELECT
      a.*,
      CASE
        WHEN a.smoothed_rate >= 1.0
        THEN a.cars_staged::double precision / (a.smoothed_rate / 60.0)
        ELSE NULL
      END AS queue_wait_minutes
    FROM assembled a
  ),

  blended AS (
    SELECT
      c.*,
      CASE
        WHEN c.median_dwell_minutes IS NOT NULL AND c.queue_wait_minutes IS NOT NULL
        THEN 0.65 * c.median_dwell_minutes + 0.35 * c.queue_wait_minutes
        WHEN c.median_dwell_minutes IS NOT NULL
        THEN c.median_dwell_minutes
        WHEN c.queue_wait_minutes IS NOT NULL
        THEN c.queue_wait_minutes
        ELSE NULL
      END AS est_wait
    FROM computed c
  )

  SELECT
    b.zone_id,
    b.cars_staged,
    b.nearby_unconfirmed,
    b.flow_rate_per_hour,
    b.smoothed_rate                                     AS smoothed_service_rate_per_hour,
    b.median_dwell_minutes,
    b.sample_size                                       AS dwell_sample_size,

    b.est_wait                                          AS estimated_wait_minutes,

    CASE
      WHEN b.est_wait IS NULL THEN NULL
      WHEN b.est_wait < 10   THEN GREATEST(0, b.est_wait - 3)
      WHEN b.est_wait < 30   THEN GREATEST(0, b.est_wait - 5)
      WHEN b.est_wait < 60   THEN GREATEST(0, b.est_wait - 10)
      ELSE                        GREATEST(0, b.est_wait - 15)
    END                                                 AS estimated_wait_min,

    CASE
      WHEN b.est_wait IS NULL THEN NULL
      WHEN b.est_wait < 10   THEN b.est_wait + 3
      WHEN b.est_wait < 30   THEN b.est_wait + 5
      WHEN b.est_wait < 60   THEN b.est_wait + 10
      ELSE                        b.est_wait + 15
    END                                                 AS estimated_wait_max,

    CASE
      WHEN b.est_wait IS NULL
        THEN 'INSUFFICIENT_DATA'
      WHEN b.sample_size >= 10
        AND b.median_dwell_minutes IS NOT NULL
        AND b.queue_wait_minutes IS NOT NULL
        AND b.smoothed_rate >= 2.0
        AND ABS(b.median_dwell_minutes - b.queue_wait_minutes) <= 15
        THEN 'HIGH'
      WHEN b.sample_size BETWEEN 4 AND 9
        OR (b.median_dwell_minutes IS NOT NULL AND b.queue_wait_minutes IS NULL)
        OR (b.median_dwell_minutes IS NULL     AND b.queue_wait_minutes IS NOT NULL)
        THEN 'MEDIUM'
      WHEN b.sample_size BETWEEN 1 AND 3
        OR b.smoothed_rate < 1.0
        THEN 'LOW'
      ELSE 'INSUFFICIENT_DATA'
    END                                                 AS wait_confidence,

    CASE
      WHEN b.est_wait IS NULL AND b.cars_staged = 0
        THEN 'INSUFFICIENT_DATA'
      WHEN b.est_wait IS NULL AND b.cars_staged > 0
        THEN 'NO_RECENT_MOVEMENT'
      ELSE 'OK'
    END                                                 AS wait_status,

    b.last_updated

  FROM blended b;
END;
$$;

GRANT EXECUTE ON FUNCTION get_zone_live_stats() TO authenticated;

-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
-- ▶ 021_one_open_visit_per_driver.sql
-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

-- ============================================================
-- 021_one_open_visit_per_driver.sql   (Issue 4 — CNT-1/CNT-2/CNT-5)
--
-- The geofence path inserts a zone_visits row on entry, but the polygon-poll
-- (activeLocationTask) path promoted to STAGED without one, and the manual button
-- always inserted a new row. Result: drivers counted with no dwell history, and
-- duplicate open visits.
--
-- Fix: a single idempotent ensure_open_visit() RPC both detection paths and the
-- manual button call through, backed by a unique partial index guaranteeing at
-- most one OPEN visit per driver.
--
-- Append-only + non-destructive: pre-existing duplicate open rows are closed
-- (exited_at = now()) before the index is created so it can be built.
-- ============================================================

-- 1. Close any pre-existing duplicate open visits, keeping the most recent per
--    driver, so the unique index below can be created.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY driver_id
           ORDER BY entered_at DESC NULLS LAST, id
         ) AS rn
  FROM zone_visits
  WHERE exited_at IS NULL
)
UPDATE zone_visits zv
SET exited_at = now()
FROM ranked r
WHERE zv.id = r.id
  AND r.rn > 1;

-- 2. At most one open visit per driver.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_visit_per_driver
  ON zone_visits (driver_id)
  WHERE exited_at IS NULL;

-- 3. Idempotent open-visit ensurer. Ownership-checked; service_role may bypass.
CREATE OR REPLACE FUNCTION ensure_open_visit(p_driver_id uuid, p_zone_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_id         uuid;
BEGIN
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot open a visit for another driver';
  END IF;

  -- Reuse an existing open visit for the SAME zone (idempotent).
  SELECT id INTO v_id
  FROM zone_visits
  WHERE driver_id = p_driver_id
    AND zone_id   = p_zone_id
    AND exited_at IS NULL
  ORDER BY entered_at DESC NULLS LAST
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Driver had an open visit in a DIFFERENT zone but never exited it → close it
  -- so the one-open-visit-per-driver invariant holds and counts don't double.
  UPDATE zone_visits
  SET exited_at = now()
  WHERE driver_id = p_driver_id
    AND exited_at IS NULL;

  INSERT INTO zone_visits (driver_id, zone_id, entered_at)
  VALUES (p_driver_id, p_zone_id, now())
  RETURNING id INTO v_id;
  RETURN v_id;

EXCEPTION WHEN unique_violation THEN
  -- A concurrent device won the insert race; return whatever open row exists.
  SELECT id INTO v_id
  FROM zone_visits
  WHERE driver_id = p_driver_id
    AND exited_at IS NULL
  ORDER BY entered_at DESC NULLS LAST
  LIMIT 1;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ensure_open_visit(uuid, uuid) TO authenticated;

-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
-- ▶ 022_postgis_zone_geometry.sql
-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

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

-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
-- ▶ 023_validated_presence_and_eligibility.sql
-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

-- ============================================================
-- 023_validated_presence_and_eligibility.sql  (Issue 5 / SEC-3,SEC-4 — part 2)
--
-- Moves the "is this driver countable?" decision to the backend:
--   1. upsert_driver_presence_validated() recomputes the TRUE zone from the
--      coordinates via ST_Contains (ignoring the client's claimed zone), enforces
--      the per-zone accuracy ceiling, and only stamps classification='STAGING'
--      when the point is genuinely inside an active zone polygon — otherwise
--      UNKNOWN (near) or ACTIVE (null zone). A spoofed/ drifted client can no
--      longer claim STAGING anywhere.
--   2. eligible_driver_presence view encodes ALL counting conditions.
--   3. get_zone_live_stats.cars_staged now reads from that view.
--
-- Backward compatible: the old upsert_driver_presence() (migration 018) is kept
-- so the client can fall back if this RPC isn't deployed. EXECUTE on the live
-- stats RPC stays authenticated-only (anon revoked in 019).
-- ============================================================

-- ── 1. Validated presence upsert ─────────────────────────────────────────────
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
SET search_path = public
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
    -- Genuinely inside a zone polygon with an acceptable fix → confirmed STAGING.
    v_final_zone := v_true_zone;
    v_final_cls  := 'STAGING';
  ELSIF p_zone_id IS NOT NULL AND v_req_class IN ('STAGING', 'UNKNOWN') THEN
    -- Near a zone (client claim) but not confirmed inside → nearby/unconfirmed.
    v_final_zone := p_zone_id;
    v_final_cls  := 'UNKNOWN';
  ELSE
    -- Participating but not at any zone.
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

-- ── 2. eligible_driver_presence — the counting authority ─────────────────────
-- A driver counts toward a zone only if ALL hold:
--   (1) tracking_enabled, (2) driver status 'staged', (3) account active,
--   (4) current_zone_id set, (5) classification 'STAGING', (6) fresh ping (TTL),
--   (7) accuracy within the (per-zone) ceiling, (8) the zone has a polygon,
--   (9) ST_Contains puts the stored point inside that zone's polygon.
-- Coordinates never leave this view to clients (no GRANT); only the SECURITY
-- DEFINER get_zone_live_stats() reads it, and it returns counts only.
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

-- ── 3. Repoint get_zone_live_stats.cars_staged to the eligible view ──────────
DROP FUNCTION IF EXISTS get_zone_live_stats();

CREATE FUNCTION get_zone_live_stats()
RETURNS TABLE (
  zone_id                       uuid,
  cars_staged                   int,
  nearby_unconfirmed            int,
  flow_rate_per_hour            double precision,
  smoothed_service_rate_per_hour double precision,
  median_dwell_minutes          double precision,
  dwell_sample_size             int,
  estimated_wait_minutes        double precision,
  estimated_wait_min            double precision,
  estimated_wait_max            double precision,
  wait_confidence               text,
  wait_status                   text,
  last_updated                  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ttl interval := interval '90 seconds';
BEGIN
  RETURN QUERY
  WITH

  -- cars_staged: server-validated eligibility (ST_Contains, accuracy, freshness,
  -- tracking/status/account). nearby_unconfirmed: UNKNOWN presence (TTL-gated).
  staged_counts AS (
    SELECT edp.current_zone_id AS zone_id,
           COUNT(DISTINCT edp.driver_id)::int AS cars_staged
    FROM eligible_driver_presence edp
    GROUP BY edp.current_zone_id
  ),
  nearby_counts AS (
    SELECT dp.current_zone_id AS zone_id,
           COUNT(DISTINCT dp.driver_id)::int AS nearby_unconfirmed
    FROM driver_presence dp
    WHERE dp.last_ping_at > now() - v_ttl
      AND dp.current_zone_id IS NOT NULL
      AND dp.classification = 'UNKNOWN'
    GROUP BY dp.current_zone_id
  ),

  dep_15m AS (
    SELECT zone_id, COUNT(*)::double precision * 4 AS rate
    FROM zone_departures WHERE departed_at > now() - interval '15 minutes'
    GROUP BY zone_id
  ),
  dep_30m AS (
    SELECT zone_id, COUNT(*)::double precision * 2 AS rate
    FROM zone_departures WHERE departed_at > now() - interval '30 minutes'
    GROUP BY zone_id
  ),
  dep_60m AS (
    SELECT zone_id, COUNT(*)::double precision AS rate
    FROM zone_departures WHERE departed_at > now() - interval '60 minutes'
    GROUP BY zone_id
  ),
  smoothed_rates AS (
    SELECT
      COALESCE(d15.zone_id, d30.zone_id, d60.zone_id) AS zone_id,
      (  COALESCE(d15.rate, 0) * 0.50
       + COALESCE(d30.rate, 0) * 0.30
       + COALESCE(d60.rate, 0) * 0.20
      )                                                 AS smoothed_rate
    FROM dep_15m d15
    FULL OUTER JOIN dep_30m d30 ON d15.zone_id = d30.zone_id
    FULL OUTER JOIN dep_60m d60 ON COALESCE(d15.zone_id, d30.zone_id) = d60.zone_id
  ),

  dwell_stats AS (
    SELECT
      zv.zone_id,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY zv.dwell_seconds) / 60.0 AS median_dwell_minutes,
      COUNT(*)::int AS sample_size
    FROM zone_visits zv
    WHERE zv.exited_at IS NOT NULL
      AND zv.dwell_seconds IS NOT NULL
      AND zv.dwell_seconds BETWEEN 120 AND 7200
      AND lower(zv.classification) = 'staging'
      AND zv.exited_at > now() - interval '60 minutes'
    GROUP BY zv.zone_id
  ),

  legacy_stats AS (
    SELECT zone_id, flow_rate_per_hour FROM zone_stats
  ),

  assembled AS (
    SELECT
      sz.id                                                   AS zone_id,
      COALESCE(sc.cars_staged, 0)                            AS cars_staged,
      COALESCE(nc.nearby_unconfirmed, 0)                     AS nearby_unconfirmed,
      COALESCE(ls.flow_rate_per_hour, 0)                     AS flow_rate_per_hour,
      COALESCE(sr.smoothed_rate, 0)                          AS smoothed_rate,
      ds.median_dwell_minutes,
      COALESCE(ds.sample_size, 0)                            AS sample_size,
      now()                                                   AS last_updated
    FROM staging_zones sz
    LEFT JOIN staged_counts  sc ON sc.zone_id = sz.id
    LEFT JOIN nearby_counts  nc ON nc.zone_id = sz.id
    LEFT JOIN legacy_stats   ls ON ls.zone_id = sz.id
    LEFT JOIN smoothed_rates sr ON sr.zone_id = sz.id
    LEFT JOIN dwell_stats    ds ON ds.zone_id = sz.id
    WHERE sz.active = true
  ),

  computed AS (
    SELECT a.*,
      CASE WHEN a.smoothed_rate >= 1.0
        THEN a.cars_staged::double precision / (a.smoothed_rate / 60.0)
        ELSE NULL END AS queue_wait_minutes
    FROM assembled a
  ),

  blended AS (
    SELECT c.*,
      CASE
        WHEN c.median_dwell_minutes IS NOT NULL AND c.queue_wait_minutes IS NOT NULL
          THEN 0.65 * c.median_dwell_minutes + 0.35 * c.queue_wait_minutes
        WHEN c.median_dwell_minutes IS NOT NULL THEN c.median_dwell_minutes
        WHEN c.queue_wait_minutes IS NOT NULL THEN c.queue_wait_minutes
        ELSE NULL
      END AS est_wait
    FROM computed c
  )

  SELECT
    b.zone_id,
    b.cars_staged,
    b.nearby_unconfirmed,
    b.flow_rate_per_hour,
    b.smoothed_rate                                     AS smoothed_service_rate_per_hour,
    b.median_dwell_minutes,
    b.sample_size                                       AS dwell_sample_size,
    b.est_wait                                          AS estimated_wait_minutes,
    CASE
      WHEN b.est_wait IS NULL THEN NULL
      WHEN b.est_wait < 10 THEN GREATEST(0, b.est_wait - 3)
      WHEN b.est_wait < 30 THEN GREATEST(0, b.est_wait - 5)
      WHEN b.est_wait < 60 THEN GREATEST(0, b.est_wait - 10)
      ELSE GREATEST(0, b.est_wait - 15)
    END                                                 AS estimated_wait_min,
    CASE
      WHEN b.est_wait IS NULL THEN NULL
      WHEN b.est_wait < 10 THEN b.est_wait + 3
      WHEN b.est_wait < 30 THEN b.est_wait + 5
      WHEN b.est_wait < 60 THEN b.est_wait + 10
      ELSE b.est_wait + 15
    END                                                 AS estimated_wait_max,
    CASE
      WHEN b.est_wait IS NULL THEN 'INSUFFICIENT_DATA'
      WHEN b.sample_size >= 10
        AND b.median_dwell_minutes IS NOT NULL
        AND b.queue_wait_minutes IS NOT NULL
        AND b.smoothed_rate >= 2.0
        AND ABS(b.median_dwell_minutes - b.queue_wait_minutes) <= 15
        THEN 'HIGH'
      WHEN b.sample_size BETWEEN 4 AND 9
        OR (b.median_dwell_minutes IS NOT NULL AND b.queue_wait_minutes IS NULL)
        OR (b.median_dwell_minutes IS NULL     AND b.queue_wait_minutes IS NOT NULL)
        THEN 'MEDIUM'
      WHEN b.sample_size BETWEEN 1 AND 3 OR b.smoothed_rate < 1.0
        THEN 'LOW'
      ELSE 'INSUFFICIENT_DATA'
    END                                                 AS wait_confidence,
    CASE
      WHEN b.est_wait IS NULL AND b.cars_staged = 0 THEN 'INSUFFICIENT_DATA'
      WHEN b.est_wait IS NULL AND b.cars_staged > 0 THEN 'NO_RECENT_MOVEMENT'
      ELSE 'OK'
    END                                                 AS wait_status,
    b.last_updated
  FROM blended b;
END;
$$;

GRANT EXECUTE ON FUNCTION get_zone_live_stats() TO authenticated;

-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
-- ▶ 024_phase5.sql
-- ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

-- LvTaxi Phase 5 schema additions
-- Run this in the Supabase SQL editor after schema.sql.

-- Push notifications + device token
alter table drivers add column if not exists push_token text;
alter table drivers add column if not exists device_platform text;

-- Track per-zone notification cooldowns
create table if not exists driver_zone_notifications (
  driver_id uuid references drivers(id) on delete cascade,
  zone_id uuid references staging_zones(id) on delete cascade,
  kind text not null,
  last_sent_at timestamptz default now(),
  primary key (driver_id, zone_id, kind)
);

-- Departures log used by zoneStatsEngine.decrementZoneCount
create table if not exists zone_departures (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid references staging_zones(id) on delete cascade,
  departed_at timestamptz default now()
);
create index if not exists zone_departures_zone_time
  on zone_departures(zone_id, departed_at desc);

-- One trajectory per visit (required for visitProcessor upsert)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trajectories_visit_id_key'
  ) then
    alter table trajectories add constraint trajectories_visit_id_key unique (visit_id);
  end if;
end $$;

-- RLS for new tables
alter table driver_zone_notifications enable row level security;
alter table zone_departures           enable row level security;

drop policy if exists "dzn self"              on driver_zone_notifications;
drop policy if exists "departures insert auth" on zone_departures;
drop policy if exists "departures read auth"   on zone_departures;

create policy "dzn self"
  on driver_zone_notifications for all
  to authenticated using (auth.uid() = driver_id) with check (auth.uid() = driver_id);

create policy "departures insert auth"
  on zone_departures for insert to authenticated with check (true);
create policy "departures read auth"
  on zone_departures for select to authenticated using (true);
