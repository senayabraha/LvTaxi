-- Reference routes: admin-drawn training paths for the ML classifier.
-- Each row is a labelled route shape for a specific zone, used as weighted
-- training data in the classify-trajectory Edge Function.

create table if not exists reference_routes (
  id           uuid primary key default gen_random_uuid(),
  zone_id      uuid not null references staging_zones(id) on delete cascade,
  route_type   text not null check (route_type in ('drop_off', 'staging', 'loop_then_stage')),
  features     jsonb not null,
  path_coords  jsonb,        -- [[lng, lat], ...] drawn vertices for display/audit
  source       text not null default 'drawn' check (source in ('drawn', 'driven')),
  recorded_by  uuid references drivers(id) on delete set null,
  recorded_at  timestamptz not null default now()
);

-- Admins can manage routes; the service role (Edge Function) can read them.
alter table reference_routes enable row level security;

create policy "Admins can manage reference routes"
  on reference_routes
  for all
  using (
    exists (
      select 1 from drivers
      where drivers.id = auth.uid()
        and drivers.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from drivers
      where drivers.id = auth.uid()
        and drivers.role = 'admin'
    )
  );

-- Service role bypasses RLS by default; no extra policy needed for Edge Functions.

create index reference_routes_zone_id_idx on reference_routes (zone_id);
create index reference_routes_route_type_idx on reference_routes (route_type);
