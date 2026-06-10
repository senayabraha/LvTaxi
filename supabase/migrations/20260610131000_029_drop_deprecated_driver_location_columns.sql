-- 029 / DATA-3: drop deprecated drivers.current_lat/current_lng.
--
-- Grep confirmed no app, admin, or Edge Function code reads these columns.
-- Position data now lives in driver_presence.lat/lng. The latest
-- soft_delete_driver() definition still nulled the legacy columns, so redefine
-- it before dropping them.

CREATE OR REPLACE FUNCTION soft_delete_driver(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE drivers
  SET
    deleted_at                = now(),
    full_name                 = 'Deleted user',
    email                     = null,
    phone                     = null,
    push_token                = null,
    device_platform           = null,
    current_zone_id           = null,
    status                    = 'off_duty',
    deletion_status           = 'deleted',
    deletion_token            = null,
    deletion_token_expires_at = null
  WHERE id = p_driver_id;
END;
$$;

COMMENT ON FUNCTION soft_delete_driver(uuid) IS
  'Soft-deletes a driver account. Driver coordinates are not stored on drivers; use driver_presence.lat/lng.';

ALTER TABLE drivers
  DROP COLUMN IF EXISTS current_lat,
  DROP COLUMN IF EXISTS current_lng;
