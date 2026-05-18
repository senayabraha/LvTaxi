-- LvTaxi migration 006 — account lifecycle.
-- Adds:
--   1. drivers.deleted_at + RLS filter so soft-deleted accounts disappear.
--   2. soft_delete_driver() — used by the delete-account Edge Function.
--   3. close_stale_zone_visits() — closes visits orphaned by force-quit.
--   4. pg_cron schedule running every 30 minutes.

-- ──────────────────────────────────────────
-- 1. SOFT-DELETE COLUMN + RLS
-- ──────────────────────────────────────────
alter table drivers
  add column if not exists deleted_at timestamptz;

create index if not exists drivers_deleted_at_idx on drivers(deleted_at)
  where deleted_at is null;

-- Replace driver_own_record so soft-deleted rows are hidden from the owning user.
-- Admins keep visibility for audit purposes via the existing admin_read_all policy.
drop policy if exists driver_own_record on drivers;
create policy driver_own_record on drivers
  for all to authenticated
  using (auth.uid() = id and deleted_at is null)
  with check (auth.uid() = id);

-- ──────────────────────────────────────────
-- 2. SOFT DELETE FUNCTION
-- ──────────────────────────────────────────
-- Called from the delete-account Edge Function after it verifies the caller.
-- Wipes identifiable fields but retains the row so foreign-key history
-- (zone_visits, trajectories) remains intact for aggregate analytics.
create or replace function soft_delete_driver(p_driver_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update drivers
  set
    deleted_at      = now(),
    full_name       = 'Deleted user',
    email           = null,
    phone           = null,
    push_token      = null,
    device_platform = null,
    current_lat     = null,
    current_lng     = null,
    current_zone_id = null,
    status          = 'off_duty'
  where id = p_driver_id;
end;
$$;

-- ──────────────────────────────────────────
-- 3. STALE VISIT RECONCILIATION
-- ──────────────────────────────────────────
-- Closes visits orphaned by app force-quit (entered, never exited).
-- 12-hour threshold: longer than any plausible staging shift, short enough
-- that zone_stats.cars_staged does not drift for more than half a day.
create or replace function close_stale_zone_visits()
returns int language plpgsql security definer set search_path = public as $$
declare
  affected int;
  v record;
begin
  affected := 0;
  for v in
    select id, zone_id, entered_at
    from zone_visits
    where exited_at is null
      and entered_at < now() - interval '12 hours'
  loop
    update zone_visits
    set exited_at = entered_at + interval '12 hours',
        dwell_seconds = extract(epoch from interval '12 hours')::int,
        classification = coalesce(classification, 'unknown')
    where id = v.id;

    -- Decrement zone_stats if this visit had been counted as staged.
    update zone_stats
    set cars_staged = greatest(cars_staged - 1, 0),
        last_updated = now()
    where zone_id = v.zone_id;

    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- ──────────────────────────────────────────
-- 4. SCHEDULE (pg_cron if available)
-- ──────────────────────────────────────────
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule('lvtaxi_close_stale_visits')
      where exists (select 1 from cron.job where jobname = 'lvtaxi_close_stale_visits');
    perform cron.schedule(
      'lvtaxi_close_stale_visits',
      '*/30 * * * *',
      $cron$ select close_stale_zone_visits(); $cron$
    );
  else
    raise notice 'pg_cron not available — call close_stale_zone_visits() manually or via Supabase Scheduled Functions.';
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;
