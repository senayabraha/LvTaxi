-- LvTaxi migration 004 — zone_audit_log.
-- Records every admin change to staging_zones for accountability.
-- zone_id is NOT a FK so records survive zone deletion.
-- Requires: 001_add_auth_columns.sql (is_admin() function).

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

-- Fast lookups by zone and by time
create index if not exists zone_audit_log_zone_id    on zone_audit_log(zone_id);
create index if not exists zone_audit_log_changed_at on zone_audit_log(changed_at desc);

-- RLS
alter table zone_audit_log enable row level security;

drop policy if exists "audit log admin read"   on zone_audit_log;
drop policy if exists "audit log admin insert" on zone_audit_log;

-- Admins can read the full log
create policy "audit log admin read"
  on zone_audit_log for select
  to authenticated
  using (is_admin(auth.uid()));

-- Admins can insert entries (writes come from the admin dashboard client)
create policy "audit log admin insert"
  on zone_audit_log for insert
  to authenticated
  with check (is_admin(auth.uid()));
