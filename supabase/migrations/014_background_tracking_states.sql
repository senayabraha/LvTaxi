-- ============================================================
-- 014_background_tracking_states.sql
-- Automatic background-tracking state machine support (non-destructive).
--
-- Adds the new driver statuses + columns the app's automatic tracking system
-- needs, and makes sure EXIT_GRACE / PASSIVE / ACTIVE(no zone) presence rows are
-- never counted toward a staging queue. Safe / idempotent: only widens CHECK
-- constraints and ADDs columns IF NOT EXISTS. No existing rows are invalidated
-- (the legacy 'off_duty' value is kept in the allowed set).
--
-- New driver statuses:
--   passive_far, passive_near, active, staged, exit_grace, tracking_disabled
--   (+ legacy: off_duty)
--
-- Counting rule (unchanged + reinforced): live staging counts come ONLY from
-- active_driver_presence / get_zone_live_stats(), which already require
-- classification IN ('STAGING','UNKNOWN') AND current_zone_id IS NOT NULL. So:
--   • PASSIVE_*  → no presence row written at all → not counted.
--   • EXIT_GRACE → presence cleared on entry (classification EXIT_GRACE if ever
--                  written is excluded by the view) → not counted.
--   • ACTIVE     → presence row has current_zone_id NULL → not counted in a queue.
--   • STAGED     → classification STAGING + zone_id set → counted while fresh.
-- ============================================================

-- ── 1. Widen drivers.status to the automatic-tracking states ─────────────────
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_status_check;
ALTER TABLE drivers
  ADD CONSTRAINT drivers_status_check
  CHECK (status IN (
    'passive_far',
    'passive_near',
    'active',
    'staged',
    'exit_grace',
    'tracking_disabled',
    -- legacy, retained so old rows remain valid
    'off_duty'
  ));

-- A brand-new driver starts with tracking disabled until app-launch
-- reconciliation (permission + position) moves them into a passive/active state.
ALTER TABLE drivers ALTER COLUMN status SET DEFAULT 'tracking_disabled';

-- ── 2. New driver columns ────────────────────────────────────────────────────
-- (current_zone_id, gps_tier, work_area_entry_time, work_area_exit_time already
-- exist from earlier migrations.)
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS tracking_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS work_area_exit_started_at timestamptz;

-- ── 3. Allow EXIT_GRACE on driver_presence (defensive) ───────────────────────
-- The app clears presence when entering EXIT_GRACE rather than writing this
-- classification, but we widen the CHECK so a future EXIT_GRACE row can never
-- violate the constraint. The active_driver_presence view and get_zone_live_stats
-- still only count STAGING / UNKNOWN, so EXIT_GRACE remains uncounted.
ALTER TABLE driver_presence
  DROP CONSTRAINT IF EXISTS driver_presence_classification_check;
ALTER TABLE driver_presence
  ADD CONSTRAINT driver_presence_classification_check
  CHECK (classification IN (
    'STAGING','UNKNOWN','PASSING','DROP_OFF','ACTIVE','EXIT_GRACE'
  ));

-- ── 4. upsert_driver_presence(): accept EXIT_GRACE in the whitelist ──────────
-- Identical to migration 012's secured version, with 'EXIT_GRACE' added to the
-- valid-classification list (everything else still normalizes to 'ACTIVE',
-- which is uncounted).
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
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot upsert presence for another driver';
  END IF;

  v_class := upper(coalesce(p_classification, 'ACTIVE'));
  IF v_class NOT IN ('STAGING','UNKNOWN','PASSING','DROP_OFF','ACTIVE','EXIT_GRACE') THEN
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

-- ── 5. Reinforce the live view (EXIT_GRACE explicitly excluded) ──────────────
-- Same 90s TTL + STAGING/UNKNOWN + non-null zone rule as migration 011. Restated
-- here so the counting contract lives alongside the new states. Idempotent.
CREATE OR REPLACE VIEW active_driver_presence AS
SELECT *
FROM driver_presence
WHERE last_ping_at > now() - interval '90 seconds'
  AND current_zone_id IS NOT NULL
  AND classification IN ('STAGING', 'UNKNOWN');
