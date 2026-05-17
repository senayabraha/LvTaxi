-- LvTaxi auth migration — ADDITIVE ONLY.
-- Safe to run multiple times. Does NOT drop drivers, zone_visits,
-- trajectories, driver_zone_history, notifications, or zone_departures.

alter table drivers
  add column if not exists role text default 'driver',
  add column if not exists zone_entry_time timestamptz,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists full_name text default 'Driver';

-- Normalize timestamp types (no-op if already timestamptz).
alter table drivers alter column created_at type timestamptz using created_at at time zone 'utc';
alter table drivers alter column last_seen  type timestamptz using last_seen  at time zone 'utc';

-- Migrate any rows whose status is 'browsing' (no longer valid) to 'off_duty'.
update drivers set status = 'off_duty' where status = 'browsing';

-- Replace check constraints.
alter table drivers drop constraint if exists drivers_status_check;
alter table drivers drop constraint if exists drivers_role_check;
alter table drivers add constraint drivers_status_check check (status in ('active','staged','off_duty'));
alter table drivers add constraint drivers_role_check   check (role   in ('driver','admin'));

-- updated_at trigger.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists drivers_set_updated_at on drivers;
create trigger drivers_set_updated_at
  before update on drivers
  for each row execute function set_updated_at();

-- SECURITY DEFINER admin check — bypasses RLS to avoid recursion.
create or replace function is_admin(user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from drivers where id = user_id and role = 'admin');
$$;

-- RLS policies. Drop any prior versions then recreate.
alter table drivers enable row level security;

drop policy if exists "drivers self read"    on drivers;
drop policy if exists "drivers self insert"  on drivers;
drop policy if exists "drivers self update"  on drivers;
drop policy if exists driver_own_record on drivers;
drop policy if exists admin_read_all    on drivers;

create policy driver_own_record on drivers
  for all to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy admin_read_all on drivers
  for select to authenticated
  using (is_admin(auth.uid()));
