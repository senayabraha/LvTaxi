-- Migration 026: pg_cron backstop for stale driver_presence rows
--
-- Even after the LIFE-3/LIFE-6 fixes, edge cases (force-quit, network loss,
-- OS process kill) can leave driver_presence rows alive past the 90s TTL.
-- This scheduled function nulls the zone and resets classification on stale
-- rows so they stop appearing in live counts without manual intervention.
--
-- Uses the same guarded pg_cron pattern as migration 006.
-- The JS constant PRESENCE_TTL_SECONDS = 90 is mirrored as interval '90 seconds'.

CREATE OR REPLACE FUNCTION clear_stale_driver_presence()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  affected int;
BEGIN
  WITH cleared AS (
    UPDATE driver_presence
    SET
      current_zone_id = NULL,
      classification  = 'ACTIVE',
      last_ping_at    = now()
    WHERE last_ping_at < now() - interval '90 seconds'
    RETURNING 1
  )
  SELECT count(*) INTO affected FROM cleared;
  RETURN COALESCE(affected, 0);
END;
$$;

-- Schedule via pg_cron if available; fall back to a notice otherwise.
-- Runs every minute so a stale row is cleared within ~2× the TTL window.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule('lvtaxi_clear_stale_presence')
      WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'lvtaxi_clear_stale_presence'
      );
    PERFORM cron.schedule(
      'lvtaxi_clear_stale_presence',
      '* * * * *',
      $cron$ SELECT clear_stale_driver_presence(); $cron$
    );
  ELSE
    RAISE NOTICE 'pg_cron not available — call clear_stale_driver_presence() manually or via Supabase Scheduled Functions.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
