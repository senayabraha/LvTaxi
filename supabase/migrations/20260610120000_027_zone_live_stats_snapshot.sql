-- Migration 027: zone_live_stats_snapshot table + pg_cron refresh
--
-- SCALE-1: get_zone_live_stats() is a heavy multi-CTE query recomputed by every
-- client on every 30-second poll. At scale this is N clients × heavy recompute
-- per 30 s. Fix: a single pg_cron job refreshes a lightweight snapshot table
-- every 10 seconds; clients subscribe to the snapshot via Supabase Realtime and
-- drop their per-client poll.
--
-- The snapshot table mirrors the get_zone_live_stats() return shape so the
-- JS layer can use it as a drop-in. A refreshed_at column lets clients detect
-- stale snapshots. get_zone_live_stats() is kept as a fallback.
--
-- Append-only / non-destructive. Uses the same guarded pg_cron pattern as
-- migrations 006 and 026.

-- ── Snapshot table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS zone_live_stats_snapshot (
  zone_id                        uuid        PRIMARY KEY REFERENCES staging_zones(id) ON DELETE CASCADE,
  cars_staged                    int         NOT NULL DEFAULT 0,
  nearby_unconfirmed             int         NOT NULL DEFAULT 0,
  flow_rate_per_hour             double precision NOT NULL DEFAULT 0,
  smoothed_service_rate_per_hour double precision NOT NULL DEFAULT 0,
  median_dwell_minutes           double precision,
  dwell_sample_size              int         NOT NULL DEFAULT 0,
  estimated_wait_minutes         double precision,
  estimated_wait_min             double precision,
  estimated_wait_max             double precision,
  wait_confidence                text,
  wait_status                    text,
  last_updated                   timestamptz,
  refreshed_at                   timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE zone_live_stats_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshot_read_authenticated" ON zone_live_stats_snapshot;
CREATE POLICY "snapshot_read_authenticated"
  ON zone_live_stats_snapshot
  FOR SELECT TO authenticated
  USING (true);

-- ── Add to Supabase Realtime publication ─────────────────────────────────────
-- Clients subscribe to INSERT/UPDATE events on this table instead of polling
-- the heavy RPC every 30 s.

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE zone_live_stats_snapshot;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not add zone_live_stats_snapshot to supabase_realtime: %', SQLERRM;
END $$;

-- ── Refresh function ──────────────────────────────────────────────────────────
-- Runs get_zone_live_stats() and upserts the results into the snapshot table.
-- Called by pg_cron every 10 s. SECURITY DEFINER so the cron job (which runs as
-- the pg_cron extension owner) can write to the table.

CREATE OR REPLACE FUNCTION refresh_zone_live_stats_snapshot()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  affected int;
BEGIN
  WITH live AS (
    SELECT * FROM get_zone_live_stats()
  ),
  upserted AS (
    INSERT INTO zone_live_stats_snapshot (
      zone_id,
      cars_staged,
      nearby_unconfirmed,
      flow_rate_per_hour,
      smoothed_service_rate_per_hour,
      median_dwell_minutes,
      dwell_sample_size,
      estimated_wait_minutes,
      estimated_wait_min,
      estimated_wait_max,
      wait_confidence,
      wait_status,
      last_updated,
      refreshed_at
    )
    SELECT
      zone_id,
      cars_staged,
      nearby_unconfirmed,
      flow_rate_per_hour,
      smoothed_service_rate_per_hour,
      median_dwell_minutes,
      dwell_sample_size,
      estimated_wait_minutes,
      estimated_wait_min,
      estimated_wait_max,
      wait_confidence,
      wait_status,
      last_updated,
      now()
    FROM live
    ON CONFLICT (zone_id) DO UPDATE SET
      cars_staged                    = EXCLUDED.cars_staged,
      nearby_unconfirmed             = EXCLUDED.nearby_unconfirmed,
      flow_rate_per_hour             = EXCLUDED.flow_rate_per_hour,
      smoothed_service_rate_per_hour = EXCLUDED.smoothed_service_rate_per_hour,
      median_dwell_minutes           = EXCLUDED.median_dwell_minutes,
      dwell_sample_size              = EXCLUDED.dwell_sample_size,
      estimated_wait_minutes         = EXCLUDED.estimated_wait_minutes,
      estimated_wait_min             = EXCLUDED.estimated_wait_min,
      estimated_wait_max             = EXCLUDED.estimated_wait_max,
      wait_confidence                = EXCLUDED.wait_confidence,
      wait_status                    = EXCLUDED.wait_status,
      last_updated                   = EXCLUDED.last_updated,
      refreshed_at                   = EXCLUDED.refreshed_at
    RETURNING 1
  )
  SELECT count(*) INTO affected FROM upserted;
  RETURN COALESCE(affected, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_zone_live_stats_snapshot() TO authenticated;

-- ── pg_cron schedule ──────────────────────────────────────────────────────────
-- Refresh every 10 seconds. pg_cron supports second-level precision via the
-- `schedule_in_seconds` helper, but the standard cron expression fires once per
-- minute; we use a 10-second interval via cron.schedule_in_seconds if available,
-- otherwise fall back to per-minute (still a large improvement over N clients × 30s).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    -- Remove any existing schedule first so this migration is idempotent.
    PERFORM cron.unschedule('lvtaxi_refresh_zone_snapshot')
      WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'lvtaxi_refresh_zone_snapshot'
      );

    -- Use schedule_in_seconds (pg_cron >= 1.4) for 10-second precision.
    -- Fall back to every-minute cron if that function isn't present.
    BEGIN
      PERFORM cron.schedule_in_seconds(
        'lvtaxi_refresh_zone_snapshot',
        10,
        $cron$ SELECT refresh_zone_live_stats_snapshot(); $cron$
      );
    EXCEPTION WHEN undefined_function THEN
      PERFORM cron.schedule(
        'lvtaxi_refresh_zone_snapshot',
        '* * * * *',
        $cron$ SELECT refresh_zone_live_stats_snapshot(); $cron$
      );
      RAISE NOTICE 'pg_cron schedule_in_seconds not available — using per-minute fallback for zone snapshot refresh.';
    END;
  ELSE
    RAISE NOTICE 'pg_cron not available — call refresh_zone_live_stats_snapshot() manually or via Supabase Scheduled Functions.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
