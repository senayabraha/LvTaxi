-- LvTaxi migration 005 — circle_enabled column on staging_zones.
-- When false, the zone's native OS circle geofence is not registered
-- and the zone will not trigger any entry/exit detection.

alter table staging_zones
  add column if not exists circle_enabled boolean default true;

-- Back-fill any existing null rows (shouldn't exist, but be safe)
update staging_zones set circle_enabled = true where circle_enabled is null;
