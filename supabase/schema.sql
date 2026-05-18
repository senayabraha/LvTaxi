-- LvTaxi Phase 1 schema
-- Run this in the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists drivers (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text,
  email text,
  full_name text,
  status text default 'browsing',
  current_lat double precision,
  current_lng double precision,
  current_zone_id uuid,
  last_seen timestamptz,
  subscription_tier text default 'free',
  created_at timestamptz default now()
);

create table if not exists staging_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lat double precision not null,
  lng double precision not null,
  radius_meters int not null,
  lane_width_meters double precision default 5,
  lane_length_meters double precision default 20,
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists zone_stats (
  zone_id uuid primary key references staging_zones(id) on delete cascade,
  cars_staged int default 0,
  flow_rate_per_hour double precision default 0,
  wait_time_minutes double precision default 0,
  last_updated timestamptz default now()
);

create table if not exists zone_visits (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid references drivers(id) on delete cascade,
  zone_id uuid references staging_zones(id) on delete cascade,
  entered_at timestamptz,
  exited_at timestamptz,
  dwell_seconds int,
  avg_speed double precision,
  entry_speed double precision,
  exit_speed double precision,
  heading_change double precision,
  forward_creep boolean,
  confidence_score int,
  classification text,
  driver_confirmed boolean default false,
  confirmed_label text
);

create table if not exists trajectories (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid references zone_visits(id) on delete cascade,
  gps_points jsonb,
  features jsonb,
  ai_classification text,
  ai_confidence double precision,
  ground_truth text,
  created_at timestamptz default now()
);

create table if not exists driver_zone_history (
  driver_id uuid references drivers(id) on delete cascade,
  zone_id uuid references staging_zones(id) on delete cascade,
  total_visits int default 0,
  staging_count int default 0,
  dropoff_count int default 0,
  history_score int default 0,
  primary key (driver_id, zone_id)
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid references drivers(id) on delete cascade,
  zone_id uuid references staging_zones(id) on delete cascade,
  type text,
  message text,
  sent_at timestamptz default now(),
  read boolean default false
);

-- Realtime: include zone_stats so the client sees live updates.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'zone_stats'
  ) then
    alter publication supabase_realtime add table zone_stats;
  end if;
end $$;

-- Row Level Security
alter table drivers enable row level security;
alter table staging_zones enable row level security;
alter table zone_stats enable row level security;
alter table zone_visits enable row level security;
alter table trajectories enable row level security;
alter table driver_zone_history enable row level security;
alter table notifications enable row level security;

-- Drop any prior versions so re-runs are idempotent.
drop policy if exists "zones readable by authenticated"      on staging_zones;
drop policy if exists "zone_stats readable by authenticated" on zone_stats;
drop policy if exists "drivers self read"                    on drivers;
drop policy if exists "drivers self insert"                  on drivers;
drop policy if exists "drivers self update"                  on drivers;
drop policy if exists "visits self"                          on zone_visits;
drop policy if exists "trajectories self"                    on trajectories;
drop policy if exists "history self"                         on driver_zone_history;
drop policy if exists "notifications self"                   on notifications;

-- Anyone authenticated can read zones and live stats.
create policy "zones readable by authenticated"
  on staging_zones for select
  to authenticated using (true);

create policy "zone_stats readable by authenticated"
  on zone_stats for select
  to authenticated using (true);

-- Drivers: a user can read/write only their own row.
-- Note: 001_add_auth_columns.sql drops these and replaces with driver_own_record + admin_read_all.
create policy "drivers self read"
  on drivers for select
  to authenticated using (auth.uid() = id);

create policy "drivers self insert"
  on drivers for insert
  to authenticated with check (auth.uid() = id);

create policy "drivers self update"
  on drivers for update
  to authenticated using (auth.uid() = id);

-- Visits, trajectories, history, notifications: scoped to the owning driver.
create policy "visits self"
  on zone_visits for all
  to authenticated using (auth.uid() = driver_id) with check (auth.uid() = driver_id);

create policy "trajectories self"
  on trajectories for all
  to authenticated using (
    exists (
      select 1 from zone_visits v
      where v.id = trajectories.visit_id and v.driver_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from zone_visits v
      where v.id = trajectories.visit_id and v.driver_id = auth.uid()
    )
  );

create policy "history self"
  on driver_zone_history for all
  to authenticated using (auth.uid() = driver_id) with check (auth.uid() = driver_id);

create policy "notifications self"
  on notifications for all
  to authenticated using (auth.uid() = driver_id) with check (auth.uid() = driver_id);



create table if not exists zone_departures (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid references staging_zones(id) on delete cascade,
  departed_at timestamptz default now()
);
create index if not exists zone_departures_zone_time on zone_departures(zone_id, departed_at desc);




-- Note: the following are defined in numbered migrations and intentionally
-- not duplicated here:
--   - circle_enabled column          → 005_circle_enabled.sql
--   - zone_audit_log + policies      → 004_zone_audit_log.sql (needs is_admin from 001)
--   - trajectories_visit_id_key      → phase5.sql (guarded)
--   - zone_departures + RLS          → phase5.sql

