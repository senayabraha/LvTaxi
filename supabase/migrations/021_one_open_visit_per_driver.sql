-- ============================================================
-- 021_one_open_visit_per_driver.sql   (Issue 4 — CNT-1/CNT-2/CNT-5)
--
-- The geofence path inserts a zone_visits row on entry, but the polygon-poll
-- (activeLocationTask) path promoted to STAGED without one, and the manual button
-- always inserted a new row. Result: drivers counted with no dwell history, and
-- duplicate open visits.
--
-- Fix: a single idempotent ensure_open_visit() RPC both detection paths and the
-- manual button call through, backed by a unique partial index guaranteeing at
-- most one OPEN visit per driver.
--
-- Append-only + non-destructive: pre-existing duplicate open rows are closed
-- (exited_at = now()) before the index is created so it can be built.
-- ============================================================

-- 1. Close any pre-existing duplicate open visits, keeping the most recent per
--    driver, so the unique index below can be created.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY driver_id
           ORDER BY entered_at DESC NULLS LAST, id
         ) AS rn
  FROM zone_visits
  WHERE exited_at IS NULL
)
UPDATE zone_visits zv
SET exited_at = now()
FROM ranked r
WHERE zv.id = r.id
  AND r.rn > 1;

-- 2. At most one open visit per driver.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_visit_per_driver
  ON zone_visits (driver_id)
  WHERE exited_at IS NULL;

-- 3. Idempotent open-visit ensurer. Ownership-checked; service_role may bypass.
CREATE OR REPLACE FUNCTION ensure_open_visit(p_driver_id uuid, p_zone_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_id         uuid;
BEGIN
  IF p_driver_id IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot open a visit for another driver';
  END IF;

  -- Reuse an existing open visit for the SAME zone (idempotent).
  SELECT id INTO v_id
  FROM zone_visits
  WHERE driver_id = p_driver_id
    AND zone_id   = p_zone_id
    AND exited_at IS NULL
  ORDER BY entered_at DESC NULLS LAST
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Driver had an open visit in a DIFFERENT zone but never exited it → close it
  -- so the one-open-visit-per-driver invariant holds and counts don't double.
  UPDATE zone_visits
  SET exited_at = now()
  WHERE driver_id = p_driver_id
    AND exited_at IS NULL;

  INSERT INTO zone_visits (driver_id, zone_id, entered_at)
  VALUES (p_driver_id, p_zone_id, now())
  RETURNING id INTO v_id;
  RETURN v_id;

EXCEPTION WHEN unique_violation THEN
  -- A concurrent device won the insert race; return whatever open row exists.
  SELECT id INTO v_id
  FROM zone_visits
  WHERE driver_id = p_driver_id
    AND exited_at IS NULL
  ORDER BY entered_at DESC NULLS LAST
  LIMIT 1;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ensure_open_visit(uuid, uuid) TO authenticated;
