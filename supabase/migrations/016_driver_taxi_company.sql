-- LvTaxi migration 016 — taxi_company column on drivers.
-- Lets a driver record which taxi company they currently work for. Collected
-- during onboarding and shown on the driver's own profile page only.
--
-- Additive + idempotent: never drops or recreates the drivers table, never
-- resets existing data. Nullable, so existing rows remain valid (null = not set).
-- RLS is intentionally left unchanged; the column lives on the drivers table and
-- is governed by the existing per-driver row policies.

alter table drivers
  add column if not exists taxi_company text;
