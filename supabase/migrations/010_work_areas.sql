-- Work areas: large outer geofence(s) used by the automatic GPS tier system.
-- A driver inside any active work-area polygon is "in the work area" and gets
-- Tier 2 (5s GPS); outside, the app drops to Tier 3 (20-min passive).
--
-- Requires: 001_add_auth_columns.sql (is_admin() function, drivers table).

create table if not exists work_areas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  polygon     jsonb not null,
  active      boolean not null default true,
  created_by  uuid references drivers(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists work_areas_set_updated_at on work_areas;
create trigger work_areas_set_updated_at
  before update on work_areas
  for each row execute function set_updated_at();

create index if not exists work_areas_active_idx on work_areas (active);

-- Driver tier bookkeeping.
alter table drivers add column if not exists gps_tier int not null default 3;
alter table drivers add column if not exists work_area_entry_time timestamptz;
alter table drivers add column if not exists work_area_exit_time  timestamptz;

-- RLS: everyone can read (drivers need the polygon to know if they're inside);
-- only admins can write.
alter table work_areas enable row level security;

drop policy if exists anyone_read_work_areas  on work_areas;
drop policy if exists admin_write_work_areas  on work_areas;

create policy anyone_read_work_areas
  on work_areas
  for select
  using (true);

create policy admin_write_work_areas
  on work_areas
  for all
  using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));
