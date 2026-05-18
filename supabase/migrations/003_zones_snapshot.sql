-- LvTaxi migration 003 — zones-snapshot Storage bucket.
-- Creates a public bucket holding one file: zones.geojson
-- (the canonical export of every zone with a polygon).
--
-- The admin app regenerates the file client-side after every zone write.
-- The mobile app and external tools can read it.

-- Create bucket (id = name).
insert into storage.buckets (id, name, public)
values ('zones-snapshot', 'zones-snapshot', true)
on conflict (id) do update set public = true;

-- Drop any prior policies before recreating.
drop policy if exists "zones snapshot public read"  on storage.objects;
drop policy if exists "zones snapshot admin write"  on storage.objects;
drop policy if exists "zones snapshot admin update" on storage.objects;
drop policy if exists "zones snapshot admin delete" on storage.objects;

-- Public read.
create policy "zones snapshot public read"
on storage.objects for select
to public
using (bucket_id = 'zones-snapshot');

-- Admin writes. Uses the is_admin() function from migration 001.
create policy "zones snapshot admin write"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'zones-snapshot'
  and is_admin(auth.uid())
);

create policy "zones snapshot admin update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'zones-snapshot'
  and is_admin(auth.uid())
);

create policy "zones snapshot admin delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'zones-snapshot'
  and is_admin(auth.uid())
);
