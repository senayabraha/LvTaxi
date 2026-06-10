# Database Schema, Migrations, RLS, and RPC Analysis

Analysis-only documentation. This file documents the current Supabase data model and risks. It does not change schema or migrations.

## 1. Schema baseline warning

`supabase/schema.sql` appears to be a Phase 1 baseline, not a fully current canonical schema. It still defines `drivers.status default 'browsing'`, while migration `014_background_tracking_states.sql` changes the allowed status set and default to `tracking_disabled`.

Therefore, current truth is the ordered migration set plus deployed Supabase state, not `schema.sql` alone. A future implementation phase should generate a fresh schema snapshot from the deployed database.

## 2. Tables

### `drivers`

Purpose: driver identity/profile and cross-launch participation state.

Important columns:

- `id`
- `phone`, `email`, `full_name`
- `status`
- `current_lat`, `current_lng` legacy/current location fields
- `current_zone_id`
- `last_seen`
- `subscription_tier`
- `role`, admin fields from migrations
- `tracking_enabled`
- `gps_tier`
- `work_area_entry_time`
- `work_area_exit_time`
- `work_area_exit_started_at`
- `taxi_company`

Primary key: `id`.

Foreign keys: initially references `auth.users(id)`, later migration `007_drop_drivers_auth_fk.sql` likely changes this. Confirm deployed state.

Readers:

- Mobile profile/session hydration.
- Background reconciliation.
- Admin DriversPage.

Writers:

- onboarding/profile flows.
- `persistDriverStatus()`.
- `ImStagingButton`.
- `DriverToggle` legacy.
- admin role/account tools.

Risks:

- Status writes are not centralized.
- `schema.sql` default conflicts with modern migrations.
- Legacy `off_duty` can persist.
- `current_zone_id` can diverge from `driver_presence.current_zone_id`.

### `driver_presence`

Purpose: live presence source of truth for current online/staged counts.

Important columns:

- `driver_id` primary key.
- `current_zone_id`.
- `last_ping_at`.
- `classification`.
- `lat`, `lng`, `speed`, `accuracy`, `heading`.
- `active_visit_id`.
- `updated_at`.

Primary key: `driver_id`.

Indexes:

- `current_zone_id` partial where not null.
- `last_ping_at`.

Readers:

- `active_driver_presence` view.
- `get_zone_live_stats()`.
- Admin DriversPage.

Writers:

- `upsert_driver_presence()` RPC.
- `clear_driver_presence()` RPC.

RLS/RPC:

- RLS allows drivers to manage own presence.
- RPC is `SECURITY DEFINER` and checks `p_driver_id = auth.uid()` unless service_role.

Risks:

- Clear function updates classification/zone but does not update `last_ping_at`. This is OK because null zone prevents count, but admins may see stale ping age.
- If status is passive, heartbeat never calls RPC.
- If RPC fails, UI has no current explicit reason.

### `active_driver_presence` view

Purpose: TTL-gated countable live presence.

Definition contract:

```sql
select *
from driver_presence
where last_ping_at > now() - interval '90 seconds'
  and current_zone_id is not null
  and classification in ('STAGING', 'UNKNOWN');
```

Risks:

- No direct `drivers.status` check; correct by design but requires heartbeat/status pipeline consistency.
- If `UNKNOWN` is accepted, ambiguous zone states can count.

### `staging_zones`

Purpose: zone list, geofence metadata, staging geometry, visibility.

Important columns:

- `id`, `name`, `lat`, `lng`, `radius_meters`.
- `lane_width_meters`, `lane_length_meters`.
- `active`.
- `circle_enabled`.
- `drawn_polygon`, `driven_polygon`, `use_driven_polygon`.
- `is_coming_soon`.
- `visible_to_drivers`.
- configuration version columns if present.

Readers:

- mobile `useZones`.
- `workAreaGeometry`.
- `tierManager`.
- geofence manager.
- admin pages.
- `get_zone_live_stats()`.

Writers:

- admin zone builder.
- migrations/seeds.

Risks:

- Active test zones can pollute detection.
- `get_zone_live_stats()` filters active but reviewed definition does not explicitly exclude `is_coming_soon` or invisible zones.
- Polygon validity is not enforced by constraints.

### `work_areas`

Purpose: broad polygon gate for automatic participation.

Important columns:

- `id`, `name`, `polygon`, `active`.

Readers:

- `workAreaGeometry`.
- `tierManager`.
- admin system checks.

Writers:

- admin/system migrations.

Risks:

- No active polygon means all automatic activation fails safe to passive.
- Terminal 1/T3 must be inside active work area.

### `zone_stats`

Purpose: legacy stats/cache and enriched wait fields.

Important columns:

- `zone_id` primary key.
- `cars_staged` legacy cache.
- `flow_rate_per_hour`.
- `wait_time_minutes` legacy.
- enriched wait columns: `smoothed_service_rate_per_hour`, `median_dwell_minutes`, `dwell_sample_size`, `estimated_wait_minutes`, `estimated_wait_min`, `estimated_wait_max`, `wait_confidence`, `wait_status`, `last_updated`.

Readers:

- mobile fallback/realtime display.
- admin zone pages.

Writers:

- legacy increment/decrement RPCs.
- record load/flow logic.

Risks:

- `cars_staged` is not the live source of truth.
- Realtime subscriptions to this table can make UI appear live even when count source is RPC.

### `zone_visits`

Purpose: visit sessions for dwell/classification and queue position.

Important columns:

- `id`, `driver_id`, `zone_id`.
- `entered_at`, `exited_at`, `dwell_seconds`.
- speed/heading/creep features.
- `classification`, confidence/confirmed labels.

Readers:

- queue position calculation.
- `get_zone_live_stats()` median dwell.
- visit reconciliation/analytics.

Writers:

- geofence enter/exit.
- visit processing/classification.

Risks:

- Queue position uses open visits, not active presence, so stale/open visits can make position wrong.
- Classification casing was fixed in migration 012 for dwell filter.

### `zone_departures`

Purpose: records departures/load events for flow rate.

Important columns:

- `id`, `zone_id`, `departed_at`.

Readers:

- `get_zone_live_stats()` smoothed rates.

Writers:

- `record_load_event()` and/or visit classification finalization.

Risks:

- If one driver tests alone and no departure event is recorded, wait status becomes no movement/insufficient data.
- Airport/hotel queues may need different departure semantics.

### `trajectories`

Purpose: stores GPS point buffers/features for completed visits and classification.

Important columns:

- `id`, `visit_id`, `gps_points`, `features`, `ai_classification`, `ai_confidence`, `ground_truth`, `created_at`.

Risks:

- Location privacy sensitivity.
- Buffer size and write frequency must be controlled.
- RLS must ensure drivers can access only own trajectory data and admins only authorized data.

### `driver_zone_history`

Purpose: per-driver/zone historical behavior.

Important columns:

- `driver_id`, `zone_id`, `total_visits`, `staging_count`, `dropoff_count`, `history_score`.

Risks:

- Could bias classification incorrectly if stale or trained on bad data.

### `notifications`

Purpose: driver notifications.

Important columns:

- `id`, `driver_id`, `zone_id`, `type`, `message`, `sent_at`, `read`.

Risks:

- Notification eligibility should respect passive/tracking-disabled states.

### Admin/audit tables

Likely include `zone_audit_log` and configuration/version tables. Confirm deployed state from migrations `004_zone_audit_log.sql` and `015_zone_config_versions.sql`.

## 3. Migration review summary

Chronological migration areas:

1. `001_add_auth_columns.sql` — roles/auth/admin read policies.
2. `002_zone_improvements.sql` — zone geometry/metadata and legacy RPC improvements.
3. `003_zones_snapshot.sql` — zone seed/snapshot.
4. `004_zone_audit_log.sql` — audit logging.
5. `005_circle_enabled.sql` — native geofence enable flag.
6. `006_account_lifecycle.sql` — account state.
7. `007_drop_drivers_auth_fk.sql` — drivers/auth FK change.
8. `008_zone_admin_write_policies.sql` — admin writes.
9. `009_reference_routes.sql` — reference routes.
10. `010_work_areas.sql` — work-area polygons.
11. `011_presence_based_zone_stats.sql` — driver_presence, active view, live stats RPC.
12. `012_secure_presence_and_live_stats_fix.sql` — secured presence RPC, robust dwell classification.
13. `013_finalize_visit_classification.sql` — visit finalization.
14. `014_background_tracking_states.sql` — modern status constraint/default, tracking_enabled, exit grace.
15. `015_zone_config_versions.sql` — zone config versions.
16. `016_driver_taxi_company.sql` — taxi company fields.
17. `017_account_deletion_flow.sql` — deletion lifecycle.
18. `phase5.sql` — older/larger phase migration; needs duplicate/conflict review.

## 4. Special focus findings

### Status constraints

Modern allowed driver statuses should be:

```text
passive_far, passive_near, active, staged, exit_grace, tracking_disabled, off_duty
```

`browsing` from `schema.sql` is obsolete and should not be allowed in current production.

### Presence classification constraints

Modern allowed presence classifications should include:

```text
STAGING, UNKNOWN, PASSING, DROP_OFF, ACTIVE, EXIT_GRACE
```

Only `STAGING` and `UNKNOWN` count.

### RPC security

`upsert_driver_presence` and `clear_driver_presence` are `SECURITY DEFINER` and perform an ownership check against `auth.uid()` unless service_role. This is good. Confirm grants and search_path in deployed DB.

### Legacy counters

`increment_zone_count` and `decrement_zone_count` are retained but deprecated. No new app code should use them for live counts.

## 5. Verification SQL

### Check current `drivers.status` constraint

```sql
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.drivers'::regclass
  and conname ilike '%status%';
```

### Check `drivers.status` default

```sql
select column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'drivers'
  and column_name = 'status';
```

### Check presence classification constraint

```sql
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.driver_presence'::regclass
  and conname ilike '%classification%';
```

### Check `active_driver_presence` definition

```sql
select definition
from pg_views
where schemaname = 'public'
  and viewname = 'active_driver_presence';
```

### Check grants on RPCs

```sql
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name in ('get_zone_live_stats', 'upsert_driver_presence', 'clear_driver_presence')
order by routine_name, grantee;
```

### Check RLS policies

```sql
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('drivers','driver_presence','staging_zones','work_areas','zone_visits','trajectories','zone_stats')
order by tablename, policyname;
```

### Inspect one test driver full state

```sql
select d.id, d.email, d.full_name, d.status, d.tracking_enabled,
       d.current_zone_id as driver_zone,
       d.last_seen,
       p.current_zone_id as presence_zone,
       p.classification,
       p.last_ping_at,
       now() - p.last_ping_at as presence_age,
       p.accuracy, p.speed
from drivers d
left join driver_presence p on p.driver_id = d.id
where d.id = '<driver_id>';
```

### Inspect one zone live count path

```sql
select sz.id, sz.name, sz.active, sz.visible_to_drivers, sz.is_coming_soon,
       gls.cars_staged, gls.wait_status, gls.wait_confidence, gls.last_updated
from staging_zones sz
left join get_zone_live_stats() gls on gls.zone_id = sz.id
where sz.id = '<zone_id>';
```

## 6. Recommended database improvements

1. Create a generated current schema snapshot from production.
2. Add admin SQL health views for zone geometry and driver status/presence mismatches.
3. Add a `driver_presence_debug` or audit trail for failed/stale heartbeat diagnostics, if privacy policy allows.
4. Ensure `get_zone_live_stats()` excludes coming-soon and invisible zones if those should not appear in driver-facing stats.
5. Add database-side validation functions for active zone geometry completeness.
6. Add SQL view to detect `drivers.current_zone_id != driver_presence.current_zone_id`.
7. Keep legacy counters but mark them deprecated in docs/admin UI.
