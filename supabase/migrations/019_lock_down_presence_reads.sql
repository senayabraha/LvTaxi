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
