-- ============================================================
-- 011_presence_based_zone_stats.sql
-- Presence-based live car counts + blended wait-time model.
--
-- What this migration does (non-destructive):
--   1. Adds driver_presence table (source of truth for live counts).
--   2. Creates active_driver_presence view (90-second TTL).
--   3. Adds rich wait-time columns to zone_stats.
--   4. Creates get_zone_live_stats() RPC (blended wait model).
--   5. Deprecates increment_zone_count / decrement_zone_count in comments
--      (functions kept for backward compat; apps should stop calling them).
-- ============================================================

-- ── 1. driver_presence table ─────────────────────────────────────────────────
-- Reuse drivers.current_zone_id as the join key where possible.
-- This table is the single live presence store; updated on every GPS ping.

CREATE TABLE IF NOT EXISTS driver_presence (
  driver_id        uuid        PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  current_zone_id  uuid        REFERENCES staging_zones(id) ON DELETE SET NULL,
  last_ping_at     timestamptz NOT NULL DEFAULT now(),
  classification   text        NOT NULL DEFAULT 'UNKNOWN'
                               CHECK (classification IN ('STAGING','UNKNOWN','PASSING','DROP_OFF','ACTIVE')),
  lat              double precision,
  lng              double precision,
  speed            double precision,
  accuracy         double precision,
  heading          double precision,
  active_visit_id  uuid        REFERENCES zone_visits(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_presence_zone
  ON driver_presence (current_zone_id)
  WHERE current_zone_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_presence_ping
  ON driver_presence (last_ping_at);

-- RLS: drivers can upsert their own row; everyone can read.
ALTER TABLE driver_presence ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'driver_presence' AND policyname = 'drivers_manage_own_presence'
  ) THEN
    CREATE POLICY drivers_manage_own_presence ON driver_presence
      FOR ALL
      USING (auth.uid() = driver_id)
      WITH CHECK (auth.uid() = driver_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'driver_presence' AND policyname = 'all_read_presence'
  ) THEN
    CREATE POLICY all_read_presence ON driver_presence
      FOR SELECT
      USING (true);
  END IF;
END $$;

-- ── 2. active_driver_presence view (90-second TTL) ───────────────────────────
-- Every live-count consumer MUST read through this view, not the raw table.
-- 90 seconds mirrors PRESENCE_TTL_SECONDS in src/lib/constants.js.

CREATE OR REPLACE VIEW active_driver_presence AS
SELECT *
FROM driver_presence
WHERE last_ping_at > now() - interval '90 seconds'
  AND current_zone_id IS NOT NULL
  AND classification IN ('STAGING', 'UNKNOWN');

-- ── 3. Extend zone_stats with rich wait-time columns ─────────────────────────

ALTER TABLE zone_stats
  ADD COLUMN IF NOT EXISTS smoothed_service_rate_per_hour double precision,
  ADD COLUMN IF NOT EXISTS median_dwell_minutes           double precision,
  ADD COLUMN IF NOT EXISTS dwell_sample_size              int,
  ADD COLUMN IF NOT EXISTS estimated_wait_minutes         double precision,
  ADD COLUMN IF NOT EXISTS estimated_wait_min             double precision,
  ADD COLUMN IF NOT EXISTS estimated_wait_max             double precision,
  ADD COLUMN IF NOT EXISTS wait_confidence                text DEFAULT 'INSUFFICIENT_DATA'
                           CHECK (wait_confidence IN ('HIGH','MEDIUM','LOW','INSUFFICIENT_DATA')),
  ADD COLUMN IF NOT EXISTS wait_status                    text DEFAULT 'INSUFFICIENT_DATA'
                           CHECK (wait_status IN ('OK','NO_RECENT_MOVEMENT','INSUFFICIENT_DATA','STALE','DEGRADED'));

-- ── 4. get_zone_live_stats() RPC ─────────────────────────────────────────────
-- Returns one row per active zone with live car count from presence
-- and blended wait-time estimate.
--
-- Response shape (matches frontend ZoneStat type):
--   zone_id, cars_staged, flow_rate_per_hour,
--   smoothed_service_rate_per_hour, median_dwell_minutes, dwell_sample_size,
--   estimated_wait_minutes, estimated_wait_min, estimated_wait_max,
--   wait_confidence, wait_status, last_updated

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
  -- 15-min window annualised → per-hour
  dep_15m AS (
    SELECT
      zone_id,
      COUNT(*)::double precision * 4 AS rate   -- * 4 → per-hour
    FROM zone_departures
    WHERE departed_at > now() - interval '15 minutes'
    GROUP BY zone_id
  ),
  -- 30-min window annualised → per-hour
  dep_30m AS (
    SELECT
      zone_id,
      COUNT(*)::double precision * 2 AS rate
    FROM zone_departures
    WHERE departed_at > now() - interval '30 minutes'
    GROUP BY zone_id
  ),
  -- 60-min window (same as current flow_rate)
  dep_60m AS (
    SELECT
      zone_id,
      COUNT(*)::double precision AS rate
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
      -- weighted blend: 50% recent / 30% mid / 20% hour
      (  COALESCE(d15.rate, 0) * 0.50
       + COALESCE(d30.rate, 0) * 0.30
       + COALESCE(d60.rate, 0) * 0.20
      )                                                 AS smoothed_rate
    FROM dep_15m d15
    FULL OUTER JOIN dep_30m d30 ON d15.zone_id = d30.zone_id
    FULL OUTER JOIN dep_60m d60 ON COALESCE(d15.zone_id, d30.zone_id) = d60.zone_id
  ),

  -- ── Median dwell from recent completed STAGING visits ────────────────────
  -- Valid range: 2 min – 120 min (remove junk / absurdly long waits)
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
      AND zv.dwell_seconds BETWEEN 120 AND 7200         -- 2 min–120 min validity window
      AND zv.classification IN ('staging')
      AND zv.exited_at > now() - interval '60 minutes'
    GROUP BY zv.zone_id
  ),

  -- ── Pull legacy flow_rate from zone_stats for display ────────────────────
  legacy_stats AS (
    SELECT zone_id, flow_rate_per_hour
    FROM zone_stats
  ),

  -- ── Assemble per zone ─────────────────────────────────────────────────────
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

  -- ── Compute wait estimates ────────────────────────────────────────────────
  computed AS (
    SELECT
      a.*,
      -- queue-based wait: cars / (service_rate / 60) = minutes
      CASE
        WHEN a.smoothed_rate >= 1.0  -- at least 1 departure/hr threshold
        THEN a.cars_staged::double precision / (a.smoothed_rate / 60.0)
        ELSE NULL
      END AS queue_wait_minutes
    FROM assembled a
  ),

  -- ── Blend median dwell + queue wait ──────────────────────────────────────
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

  -- ── Final select with ranges and confidence ───────────────────────────────
  SELECT
    b.zone_id,
    b.cars_staged,
    b.flow_rate_per_hour,
    b.smoothed_rate                                     AS smoothed_service_rate_per_hour,
    b.median_dwell_minutes,
    b.sample_size                                       AS dwell_sample_size,

    -- estimated_wait_minutes (central estimate)
    b.est_wait                                          AS estimated_wait_minutes,

    -- wait range  (±3 <10m, ±5 10–30m, ±10 30–60m, ±15 >60m)
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

    -- confidence
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

    -- wait_status
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

-- ── 5. upsert_driver_presence() ──────────────────────────────────────────────
-- Called by the app on every GPS ping (replaces direct GPS column updates
-- on the drivers table for the live-count subsystem).

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
AS $$
BEGIN
  INSERT INTO driver_presence (
    driver_id, current_zone_id, last_ping_at, classification,
    lat, lng, speed, accuracy, heading, active_visit_id, updated_at
  ) VALUES (
    p_driver_id, p_zone_id, now(), p_classification,
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

-- ── 6. clear_driver_presence() ───────────────────────────────────────────────
-- Call when a driver goes off-duty or explicitly leaves a zone.

CREATE OR REPLACE FUNCTION clear_driver_presence(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE driver_presence
  SET current_zone_id = NULL,
      classification  = 'ACTIVE',
      updated_at      = now()
  WHERE driver_id = p_driver_id;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_driver_presence(uuid) TO authenticated;

-- ── NOTE: increment_zone_count / decrement_zone_count are DEPRECATED ─────────
-- They remain in migration 002 for backward compatibility but should not be
-- called for live car counts. Live counts now come from active_driver_presence
-- via get_zone_live_stats(). The old RPC functions only update zone_stats
-- which is now a display cache, not the source of truth.
