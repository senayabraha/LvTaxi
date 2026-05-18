-- LvTaxi migration 007 — drop drivers→auth.users FK.
--
-- Background: drivers.id had `references auth.users(id) on delete cascade`.
-- That cascade defeats the soft-delete from 006: deleting the auth row would
-- wipe the anonymized drivers row and all linked zone_visits/trajectories.
--
-- This migration drops the FK entirely. The delete-account Edge Function
-- no longer calls auth.admin.deleteUser; it only soft-deletes the drivers
-- row and signs the client out. The auth.users row is retained so that
-- (a) the email cannot be re-registered, and (b) zone_visits.driver_id
-- references remain valid.
--
-- Constraint name is discovered dynamically because Postgres auto-names
-- inline `references` constraints and the name can vary across environments.

do $$
declare
  fk_name text;
begin
  select conname into fk_name
  from pg_constraint
  where conrelid = 'public.drivers'::regclass
    and contype = 'f'
    and (select array_agg(attname) from pg_attribute
         where attrelid = conrelid and attnum = any(conkey)) = array['id']
    and confrelid = 'auth.users'::regclass;

  if fk_name is not null then
    execute format('alter table drivers drop constraint %I', fk_name);
    raise notice 'Dropped FK %', fk_name;
  else
    raise notice 'No drivers→auth.users FK to drop (already removed).';
  end if;
end $$;
