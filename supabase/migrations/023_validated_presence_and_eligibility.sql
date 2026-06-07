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
