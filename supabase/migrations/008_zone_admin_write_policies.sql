-- LvTaxi migration 008 — admin write policies for staging_zones and zone_stats.
-- Fixes "new row violates row-level security policy for table staging_zones"
-- that occurs when an admin imports a JSON file or manages zones through the
-- admin dashboard (which uses the anon key, so RLS is enforced).
-- Requires: 001_add_auth_columns.sql (is_admin() function).

-- staging_zones: drop any existing write policies then recreate.
drop policy if exists "zones admin insert" on staging_zones;
drop policy if exists "zones admin update" on staging_zones;
drop policy if exists "zones admin delete" on staging_zones;

create policy "zones admin insert"
  on staging_zones for insert
  to authenticated
  with check (is_admin(auth.uid()));

create policy "zones admin update"
  on staging_zones for update
  to authenticated
  using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));

create policy "zones admin delete"
  on staging_zones for delete
  to authenticated
  using (is_admin(auth.uid()));

-- zone_stats: admins need to upsert stats alongside zone creation/import.
drop policy if exists "zone_stats admin insert" on zone_stats;
drop policy if exists "zone_stats admin update" on zone_stats;

create policy "zone_stats admin insert"
  on zone_stats for insert
  to authenticated
  with check (is_admin(auth.uid()));

create policy "zone_stats admin update"
  on zone_stats for update
  to authenticated
  using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));
