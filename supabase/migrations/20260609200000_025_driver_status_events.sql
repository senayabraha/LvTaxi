-- Migration 025: driver_status_events audit table
-- Every driver status transition is recorded here so "why was I removed?" is
-- always answerable. Written by transitionDriverState() in driverStatusTransitions.js.

CREATE TABLE IF NOT EXISTS driver_status_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    uuid        REFERENCES drivers(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text        NOT NULL,
  from_zone_id uuid        REFERENCES staging_zones(id) ON DELETE SET NULL,
  to_zone_id   uuid        REFERENCES staging_zones(id) ON DELETE SET NULL,
  lat          double precision,
  lng          double precision,
  accuracy     double precision,
  source       text,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS driver_status_events_driver_time
  ON driver_status_events(driver_id, created_at DESC);

ALTER TABLE driver_status_events ENABLE ROW LEVEL SECURITY;

-- Drivers can insert and read their own events; admins can read all.
DROP POLICY IF EXISTS "status_events_self"        ON driver_status_events;
DROP POLICY IF EXISTS "status_events_admin_read"  ON driver_status_events;

CREATE POLICY "status_events_self" ON driver_status_events
  FOR ALL TO authenticated
  USING  (auth.uid() = driver_id)
  WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "status_events_admin_read" ON driver_status_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM drivers d
      WHERE d.id = auth.uid() AND d.role = 'admin'
    )
  );
