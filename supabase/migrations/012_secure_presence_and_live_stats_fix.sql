-- ============================================================
-- 012_secure_presence_and_live_stats_fix.sql
-- Hardens the presence subsystem introduced in 011 (non-destructive,
-- CREATE OR REPLACE only — does not touch tables or old migrations):
--
--   1. upsert_driver_presence()  — reject writes for another driver
--                                   + validate/normalize classification.
--   2. clear_driver_presence()    — reject clears for another driver.
--   3. get_zone_live_stats()      — median dwell filter made casing-robust
--                                   (lower(classification) = 'staging').
--
-- A service_role caller (server-side admin/maintenance) is allowed to bypass
-- the per-driver ownership check; normal authenticated users cannot spoof
-- another driver's presence.
-- ============================================================

-- ── 1. upsert_driver_presence() — secured + classification validation ────────
CREATE OR REPLACE FUNCTION upsert_driver_presence(
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
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_class      text;
BEGIN
  -- Ownership: a driver may only write their own presence row.
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot upsert presence for another driver';
  END IF;

  -- Validate / normalize classification → any unexpected value becomes ACTIVE
  -- (uncounted) rather than violating the table CHECK constraint.
  v_class := upper(coalesce(p_classification, 'ACTIVE'));
  IF v_class NOT IN ('STAGING','UNKNOWN','PASSING','DROP_OFF','ACTIVE') THEN
    v_class := 'ACTIVE';
  END IF;

  INSERT INTO driver_presence (
    driver_id, current_zone_id, last_ping_at, classification,
    lat, lng, speed, accuracy, heading, active_visit_id, updated_at
  ) VALUES (
    p_driver_id, p_zone_id, now(), v_class,
    p_lat, p_lng, p_speed, p_accuracy, p_heading, p_visit_id, now()
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
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_driver_presence(uuid, uuid, text, double precision, double precision, double precision, double precision, double precision, uuid) TO authenticated;

-- ── 2. clear_driver_presence() — secured ─────────────────────────────────────
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
      updated_at      = now()
  WHERE driver_id = p_driver_id;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_driver_presence(uuid) TO authenticated;

-- ── 3. get_zone_live_stats() — casing-robust median dwell ────────────────────
-- Identical to migration 011 EXCEPT the median-dwell visit filter now uses
-- lower(zv.classification) = 'staging' so it works whether zone_visits store
-- 'staging' (behavioralClassifier) or 'STAGING' (any upstream/remote source).
-- All wait-confidence / wait-range / smoothed-rate / derived-count logic is
-- preserved unchanged.
CREATE OR REPLACE FUNCTION get_zone_live_stats()
RETURNS TABLE (
  zone_id                       uuid,
  cars_staged                   int,
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

  -- ── Live car counts from presence (TTL-gated) ───────────────────────────
  live_counts AS (
    SELECT
      dp.current_zone_id                  AS zone_id,
      COUNT(DISTINCT dp.driver_id)::int   AS cars_staged
    FROM driver_presence dp
    WHERE dp.last_ping_at > now() - v_ttl
      AND dp.current_zone_id IS NOT NULL
      AND dp.classification IN ('STAGING', 'UNKNOWN')
    GROUP BY dp.current_zone_id
  ),

  -- ── Smoothed service rate from zone_departures (multi-window blend) ──────
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

  -- ── Median dwell from recent completed STAGING visits ────────────────────
  -- Casing-robust: matches 'staging', 'STAGING', 'Staging', etc.
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

GRANT EXECUTE ON FUNCTION get_zone_live_stats() TO authenticated, anon;
