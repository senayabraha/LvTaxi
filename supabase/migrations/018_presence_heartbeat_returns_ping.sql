-- ============================================================
-- 018_presence_heartbeat_returns_ping.sql
--
-- Problem: upsert_driver_presence() returned void, so the JS caller
-- had no way to confirm last_ping_at was actually written. If the
-- INSERT/UPDATE ran but returned nothing, "success" was assumed from
-- the absence of a JS error — even if the row was never touched.
--
-- Fix: change the function to RETURN the written last_ping_at value.
-- The JS layer now receives the actual DB timestamp and can compare it
-- to the local clock to confirm the write was fresh.
--
-- Non-destructive: CREATE OR REPLACE only. No table changes.
-- ============================================================

-- PostgreSQL cannot change a function's return type with CREATE OR REPLACE.
-- Drop the old void signature first so the timestamptz version can be created.
DROP FUNCTION IF EXISTS upsert_driver_presence(uuid, uuid, text, double precision, double precision, double precision, double precision, double precision, uuid);

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
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_class      text;
  v_ping_at    timestamptz;
BEGIN
  -- Ownership: a driver may only write their own presence row.
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot upsert presence for another driver';
  END IF;

  -- Validate / normalize classification → any unexpected value becomes ACTIVE
  v_class := upper(coalesce(p_classification, 'ACTIVE'));
  IF v_class NOT IN ('STAGING','UNKNOWN','PASSING','DROP_OFF','ACTIVE') THEN
    v_class := 'ACTIVE';
  END IF;

  v_ping_at := now();

  INSERT INTO driver_presence (
    driver_id, current_zone_id, last_ping_at, classification,
    lat, lng, speed, accuracy, heading, active_visit_id, updated_at
  ) VALUES (
    p_driver_id, p_zone_id, v_ping_at, v_class,
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

GRANT EXECUTE ON FUNCTION upsert_driver_presence(uuid, uuid, text, double precision, double precision, double precision, double precision, double precision, uuid) TO authenticated;
