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
alter publication supabase_realtime add table zone_stats;

-- Row Level Security
alter table drivers enable row level security;
alter table staging_zones enable row level security;
alter table zone_stats enable row level security;
alter table zone_visits enable row level security;
alter table trajectories enable row level security;
alter table driver_zone_history enable row level security;
alter table notifications enable row level security;

-- Anyone authenticated can read zones and live stats.
create policy "zones readable by authenticated"
  on staging_zones for select
  to authenticated using (true);

create policy "zone_stats readable by authenticated"
  on zone_stats for select
  to authenticated using (true);

-- Drivers: a user can read/write only their own row.
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



















-- circle_enabled: when false, native OS geofence circle is not registered
alter table staging_zones
  add column if not exists circle_enabled boolean default true;

-- Admin audit log: immutable record of every zone field change/delete.
-- zone_id has no FK so records survive zone deletion.
create table if not exists zone_audit_log (
  id          uuid        primary key default gen_random_uuid(),
  zone_id     uuid        not null,
  zone_name   text        not null,
  field       text        not null,
  old_value   text,
  new_value   text,
  admin_id    uuid        references drivers(id) on delete set null,
  changed_at  timestamptz not null default now()
);

create index if not exists zone_audit_log_zone_id    on zone_audit_log(zone_id);
create index if not exists zone_audit_log_changed_at on zone_audit_log(changed_at desc);

alter table zone_audit_log enable row level security;

create policy "audit log admin read"
  on zone_audit_log for select
  to authenticated
  using (is_admin(auth.uid()));

create policy "audit log admin insert"
  on zone_audit_log for insert
  to authenticated
  with check (is_admin(auth.uid()));

-- needed for trajectory upsert in visitProcessor (onConflict: visit_id)
alter table trajectories add constraint trajectories_visit_id_key unique (visit_id);

-- needed for the flow-rate query in zoneStatsEngine.decrementZoneCount
create table if not exists zone_departures (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid references staging_zones(id) on delete cascade,
  departed_at timestamptz default now()
);
create index if not exists zone_departures_zone_time on zone_departures(zone_id, departed_at desc);
