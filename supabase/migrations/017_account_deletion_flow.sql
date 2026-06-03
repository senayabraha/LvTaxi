-- LvTaxi migration 017 — safe account deletion flow.
-- Adds deletion lifecycle tracking columns to drivers and a helper stored
-- procedure used by the cancel-account-deletion Edge Function.
-- All changes are additive and idempotent.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. DELETION TRACKING COLUMNS
-- ──────────────────────────────────────────────────────────────────────────────
alter table drivers
  add column if not exists deletion_requested_at    timestamptz,
  add column if not exists deletion_confirmed_at    timestamptz,
  add column if not exists deletion_scheduled_for   timestamptz,
  add column if not exists deletion_cancelled_at    timestamptz,
  add column if not exists deletion_status          text not null default 'active',
  -- One-time token sent in the confirmation email; nulled after use.
  add column if not exists deletion_token           uuid,
  add column if not exists deletion_token_expires_at timestamptz;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. CHECK CONSTRAINT (idempotent)
-- ──────────────────────────────────────────────────────────────────────────────
alter table drivers
  drop constraint if exists drivers_deletion_status_check;

alter table drivers
  add constraint drivers_deletion_status_check
  check (deletion_status in (
    'active',
    'pending_email_confirmation',
    'scheduled_for_deletion',
    'cancelled',
    'deleted'
  ));

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. INDEX on deletion_scheduled_for for efficient cron queries
-- ──────────────────────────────────────────────────────────────────────────────
create index if not exists drivers_deletion_scheduled_for_idx
  on drivers (deletion_scheduled_for)
  where deletion_status = 'scheduled_for_deletion';

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. cancel_account_deletion() — called by the cancel Edge Function.
--    Only acts when status is 'scheduled_for_deletion' to be idempotent.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function cancel_account_deletion(p_driver_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  update drivers
  set
    deletion_status         = 'active',
    deletion_cancelled_at   = now(),
    deletion_scheduled_for  = null,
    deletion_token          = null,
    deletion_token_expires_at = null
  where id = p_driver_id
    and deletion_status = 'scheduled_for_deletion';

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. Update soft_delete_driver() to also set deletion_status = 'deleted'.
--    Redefines the function from migration 006 additively.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function soft_delete_driver(p_driver_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update drivers
  set
    deleted_at              = now(),
    full_name               = 'Deleted user',
    email                   = null,
    phone                   = null,
    push_token              = null,
    device_platform         = null,
    current_lat             = null,
    current_lng             = null,
    current_zone_id         = null,
    status                  = 'off_duty',
    deletion_status         = 'deleted',
    deletion_token          = null,
    deletion_token_expires_at = null
  where id = p_driver_id;
end;
$$;
