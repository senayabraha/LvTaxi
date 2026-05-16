-- LvTaxi Phase 5 schema additions
-- Run this in the Supabase SQL editor after schema.sql.

-- Push notifications + device token
alter table drivers add column if not exists push_token text;
alter table drivers add column if not exists device_platform text;

-- Track per-zone notification cooldowns
create table if not exists driver_zone_notifications (
  driver_id uuid references drivers(id) on delete cascade,
  zone_id uuid references staging_zones(id) on delete cascade,
  kind text not null,
  last_sent_at timestamptz default now(),
  primary key (driver_id, zone_id, kind)
);

-- Departures log used by zoneStatsEngine.decrementZoneCount
create table if not exists zone_departures (
  id uuid primary key default gen_random_uuid(),
  zone_id uuid references staging_zones(id) on delete cascade,
  departed_at timestamptz default now()
);
create index if not exists zone_departures_zone_time
  on zone_departures(zone_id, departed_at desc);

-- One trajectory per visit (required for visitProcessor upsert)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trajectories_visit_id_key'
  ) then
    alter table trajectories add constraint trajectories_visit_id_key unique (visit_id);
  end if;
end $$;

-- RLS for new tables
alter table driver_zone_notifications enable row level security;
create policy "dzn self"
  on driver_zone_notifications for all
  to authenticated using (auth.uid() = driver_id) with check (auth.uid() = driver_id);

alter table zone_departures enable row level security;
create policy "departures insert auth"
  on zone_departures for insert to authenticated with check (true);
create policy "departures read auth"
  on zone_departures for select to authenticated using (true);
