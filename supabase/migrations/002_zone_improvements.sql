-- LvTaxi migration 002 — zone improvements.
-- Run AFTER 001_add_auth_columns.sql.
--
-- This migration:
--   1. Wipes staging_zones (cascades to zone_visits, trajectories, etc.)
--      Safe pre-launch; do NOT run in production once real driver data exists.
--   2. Adds polygon columns + UNIQUE(name) for upsert.
--   3. Creates atomic stored procedures for zone counts (fixes JS race).
--   4. Schedules a job to finalize stale UNKNOWN visits (cron via pg_cron
--      if available, fallback no-op trigger if not).

-- ──────────────────────────────────────────
-- 1. WIPE staging_zones (cascades)
-- ──────────────────────────────────────────
delete from staging_zones;

-- ──────────────────────────────────────────
-- 2. ADD COLUMNS
-- ──────────────────────────────────────────
alter table staging_zones
  add column if not exists drawn_polygon       jsonb,
  add column if not exists driven_polygon      jsonb,
  add column if not exists use_driven_polygon  boolean default false,
  add column if not exists is_coming_soon      boolean default false,
  add column if not exists visible_to_drivers  boolean default true,
  add column if not exists updated_at          timestamptz default now();

-- UNIQUE(name) so importer can upsert by name.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'staging_zones_name_key'
  ) then
    alter table staging_zones add constraint staging_zones_name_key unique (name);
  end if;
end $$;

-- ──────────────────────────────────────────
-- 3. STORED PROCEDURES (atomic zone counts)
-- ──────────────────────────────────────────
create or replace function increment_zone_count(p_zone_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into zone_stats (zone_id, cars_staged, last_updated)
  values (p_zone_id, 1, now())
  on conflict (zone_id) do update
    set cars_staged  = zone_stats.cars_staged + 1,
        last_updated = now();
$$;

create or replace function decrement_zone_count(p_zone_id uuid)
returns void language sql security definer set search_path = public as $$
  update zone_stats
  set cars_staged  = greatest(cars_staged - 1, 0),
      last_updated = now()
  where zone_id = p_zone_id;
$$;

-- record_load_event: insert into zone_departures, recompute flow + wait.
-- Uses zone_departures (existing table name, not renaming).
create or replace function record_load_event(p_zone_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  new_flow numeric;
  new_cars int;
begin
  insert into zone_departures (zone_id, departed_at) values (p_zone_id, now());

  select count(*) into new_flow
  from zone_departures
  where zone_id = p_zone_id
    and departed_at > now() - interval '1 hour';

  update zone_stats
    set flow_rate_per_hour = new_flow,
        last_updated = now()
    where zone_id = p_zone_id
    returning cars_staged into new_cars;

  update zone_stats
    set wait_time_minutes = case
      when new_flow > 0 then (new_cars::float / new_flow) * 60
      else null
    end,
    last_updated = now()
    where zone_id = p_zone_id;
end;
$$;

-- ──────────────────────────────────────────
-- 4. UNKNOWN visit finalizer
-- ──────────────────────────────────────────
-- Flips UNKNOWN visits older than 5 minutes (and not yet confirmed)
-- to drop_off. Called by pg_cron if available, or manually.
create or replace function finalize_stale_unknown_visits()
returns int language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  with stale as (
    update zone_visits
    set classification = 'drop_off'
    where classification = 'unknown'
      and driver_confirmed = false
      and exited_at is not null
      and exited_at < now() - interval '5 minutes'
    returning id
  )
  select count(*) into affected from stale;

  return affected;
end;
$$;

-- Try to schedule via pg_cron. If extension is unavailable, the DO block
-- raises a notice and the manual finalize_stale_unknown_visits() function
-- is still callable from the app or a Supabase scheduled function.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule('lvtaxi_finalize_unknown')
      where exists (select 1 from cron.job where jobname = 'lvtaxi_finalize_unknown');
    perform cron.schedule(
      'lvtaxi_finalize_unknown',
      '* * * * *',
      $cron$ select finalize_stale_unknown_visits(); $cron$
    );
  else
    raise notice 'pg_cron not available — call finalize_stale_unknown_visits() manually or via Supabase Scheduled Functions.';
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;
