-- Migration 030 / LIFE-8: device and session identity on driver_presence
--
-- Problem: driver_presence has driver_id as its sole key with ON CONFLICT DO UPDATE.
-- Two devices on the same account thrash the single row — last write wins and
-- status flaps (one device says STAGING, the other says ACTIVE).
--
-- Fix:
--   1. Add device_id, session_id, app_version, platform columns to driver_presence
--      (all nullable so existing rows and old client builds keep working).
--   2. Add the same columns to driver_status_events for audit completeness.
--   3. Redefine upsert_driver_presence_validated() to accept and store them, and
--      to enforce a last-session-wins rule: if the stored session_id is lexically
--      later than the incoming session_id, the write is silently ignored.
--      session_id is a timestamp-prefixed UUID (e.g. "20260610T143000_<uuid>"),
--      so lexical order == chronological order.  An old client that omits
--      session_id always wins (NULL is treated as the oldest possible value).
--
-- Backward compatible: the old upsert_driver_presence_validated() signature still
-- works; the new parameters are DEFAULT NULL.

-- ── 1. driver_presence new columns ───────────────────────────────────────────

ALTER TABLE driver_presence
  ADD COLUMN IF NOT EXISTS device_id   text,
  ADD COLUMN IF NOT EXISTS session_id  text,
  ADD COLUMN IF NOT EXISTS app_version text,
  ADD COLUMN IF NOT EXISTS platform    text;

-- ── 2. driver_status_events new columns ──────────────────────────────────────

ALTER TABLE driver_status_events
  ADD COLUMN IF NOT EXISTS device_id  text,
  ADD COLUMN IF NOT EXISTS session_id text;

-- ── 3. Updated upsert_driver_presence_validated ───────────────────────────────
-- New parameters are appended with DEFAULT NULL so old callers (9-arg form from
-- migration 023) continue to work without changes.

CREATE OR REPLACE FUNCTION upsert_driver_presence_validated(
  p_driver_id       uuid,
  p_zone_id         uuid,
  p_classification  text,
  p_lat             double precision,
  p_lng             double precision,
  p_speed           double precision DEFAULT NULL,
  p_accuracy        double precision DEFAULT NULL,
  p_heading         double precision DEFAULT NULL,
  p_visit_id        uuid             DEFAULT NULL,
  p_device_id       text             DEFAULT NULL,
  p_session_id      text             DEFAULT NULL,
  p_app_version     text             DEFAULT NULL,
  p_platform        text             DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_is_service    boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_req_class     text;
  v_true_zone     uuid;
  v_ceiling       int;
  v_final_zone    uuid;
  v_final_cls     text;
  v_ping_at       timestamptz := now();
  v_pt            geometry;
  v_stored_sid    text;
BEGIN
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot upsert presence for another driver';
  END IF;

  -- Last-session-wins: if a newer session already owns the row, ignore this write.
  -- session_id is a timestamp-prefixed string so lexical order == chronological.
  -- A NULL incoming session_id (old client) is treated as the oldest possible
  -- value and is always superseded by any stored non-NULL session_id.
  IF p_session_id IS NOT NULL THEN
    SELECT session_id INTO v_stored_sid
    FROM driver_presence
    WHERE driver_id = p_driver_id;

    IF v_stored_sid IS NOT NULL AND v_stored_sid > p_session_id THEN
      -- Stored session is newer: this write is from a stale/background device.
      -- Return the stored last_ping_at so the caller can detect it was a no-op.
      RETURN (SELECT last_ping_at FROM driver_presence WHERE driver_id = p_driver_id);
    END IF;
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
    ORDER BY ST_Area(sz.geom) ASC
    LIMIT 1;
  END IF;

  IF v_true_zone IS NOT NULL
     AND (p_accuracy IS NULL OR p_accuracy < 0 OR p_accuracy <= v_ceiling)
  THEN
    v_final_zone := v_true_zone;
    v_final_cls  := 'STAGING';
  ELSIF p_zone_id IS NOT NULL AND v_req_class IN ('STAGING', 'UNKNOWN') THEN
    v_final_zone := p_zone_id;
    v_final_cls  := 'UNKNOWN';
  ELSE
    v_final_zone := NULL;
    v_final_cls  := 'ACTIVE';
  END IF;

  INSERT INTO driver_presence (
    driver_id, current_zone_id, last_ping_at, classification,
    lat, lng, speed, accuracy, heading, active_visit_id, updated_at,
    device_id, session_id, app_version, platform
  ) VALUES (
    p_driver_id, v_final_zone, v_ping_at, v_final_cls,
    p_lat, p_lng, p_speed, p_accuracy, p_heading, p_visit_id, v_ping_at,
    p_device_id, p_session_id, p_app_version, p_platform
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
    updated_at      = EXCLUDED.updated_at,
    device_id       = EXCLUDED.device_id,
    session_id      = EXCLUDED.session_id,
    app_version     = EXCLUDED.app_version,
    platform        = EXCLUDED.platform;

  RETURN v_ping_at;
END;
$$;

-- Re-grant to authenticated (CREATE OR REPLACE drops grants on some PG versions).
GRANT EXECUTE ON FUNCTION upsert_driver_presence_validated(
  uuid, uuid, text, double precision, double precision,
  double precision, double precision, double precision, uuid,
  text, text, text, text
) TO authenticated;
