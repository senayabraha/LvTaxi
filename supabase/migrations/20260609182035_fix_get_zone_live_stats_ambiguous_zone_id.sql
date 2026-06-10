-- ============================================================
-- 20260609182035_fix_get_zone_live_stats_ambiguous_zone_id.sql
--
-- Fix: get_zone_live_stats() errored on every call with
--   42702: column reference "zone_id" is ambiguous
-- because the function's RETURNS TABLE column names (zone_id, flow_rate_per_hour,
-- …) are in scope as PL/pgSQL variables, and the dep_15m/30m/60m and legacy_stats
-- CTEs reference those columns unqualified. (Latent since the original 011/012
-- definition; live stats were failing and the client was silently falling back.)
--
-- Resolution: add `#variable_conflict use_column` so ambiguous names resolve to
-- the table column. The function never reads its OUT params by name — RETURN
-- QUERY maps result columns to them positionally — so this is safe.
--
-- Append-only forward-fix (CREATE OR REPLACE; signature/return type unchanged).
-- ============================================================

CREATE OR REPLACE FUNCTION get_zone_live_stats()
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
#variable_conflict use_column
DECLARE
  v_ttl interval := interval '90 seconds';
BEGIN
  RETURN QUERY
  WITH

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
    SELECT zd.zone_id, COUNT(*)::double precision * 4 AS rate
    FROM zone_departures zd WHERE zd.departed_at > now() - interval '15 minutes'
    GROUP BY zd.zone_id
  ),
  dep_30m AS (
    SELECT zd.zone_id, COUNT(*)::double precision * 2 AS rate
    FROM zone_departures zd WHERE zd.departed_at > now() - interval '30 minutes'
    GROUP BY zd.zone_id
  ),
  dep_60m AS (
    SELECT zd.zone_id, COUNT(*)::double precision AS rate
    FROM zone_departures zd WHERE zd.departed_at > now() - interval '60 minutes'
    GROUP BY zd.zone_id
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
    SELECT zs.zone_id, zs.flow_rate_per_hour FROM zone_stats zs
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
