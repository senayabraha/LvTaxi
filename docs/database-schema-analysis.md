# LV Taxi — Database Schema, Migrations, RLS & RPC Analysis

> Analysis-only. Per-table documentation, migration history, and verification SQL.
> Authoritative schema = `supabase/schema.sql` **plus** migrations `001`–`017` + `phase5.sql`
> (schema.sql is intentionally Phase-1-only; see its note at `schema.sql:181-187`).

---

## 1. Per-table reference

### `drivers`
- **Purpose:** driver identity, status, location snapshot, lifecycle/deletion.
- **PK:** `id uuid` = `auth.users(id)` (FK, `on delete cascade`).
- **Key cols:** `status`, `tracking_enabled`, `current_lat/lng`, `current_zone_id`, `gps_tier`,
  `work_area_entry_time`, `work_area_exit_time`, `work_area_exit_started_at`, `push_token`,
  `device_platform`, `taxi_company`, `deleted_at`, deletion-flow columns (017).
- **status DEFAULT history:** `browsing` (schema.sql:11, *invalid vs later CHECK*) → `off_duty`
  (001) → `tracking_disabled` (014:42).
- **status CHECK history:** `('active','staged','off_duty')` (001:19) → widened to 7 values in
  `014:26` (`passive_far,passive_near,active,staged,exit_grace,tracking_disabled,off_duty`).
- **Readers:** mobile (own row), admin (all via `admin_read_all`), edge fns. **Writers:** mobile
  (own), background tasks, RPCs.
- **RLS:** `driver_own_record` (self, `deleted_at is null` in USING) + `admin_read_all`
  (001:58-65, 006:20-23).
- **Risks:** invalid default in schema.sql; soft-deleted driver can still UPDATE (deleted_at only in
  USING, not WITH CHECK — 006).

### `driver_presence`
- **Purpose:** live presence; the **source of truth for counts**.
- **PK:** `driver_id`. **FKs:** `current_zone_id`→staging_zones (set null), `active_visit_id`→zone_visits.
- **Key cols:** `last_ping_at`, `classification`, `lat/lng/speed/accuracy/heading`, `updated_at`.
- **classification CHECK:** `('STAGING','UNKNOWN','PASSING','DROP_OFF','ACTIVE')` (011:23) → add
  `EXIT_GRACE` (014:58).
- **Indexes:** partial on `current_zone_id` (where not null), on `last_ping_at` (011:33-38).
- **RLS:** `drivers_manage_own_presence` (self ALL) + `all_read_presence` (SELECT true)
  (011:43-64). **Privacy risk:** any authenticated user can read everyone's live lat/lng.
- **Written by:** `upsert_driver_presence`/`clear_driver_presence` RPCs only (client funnels through
  `zoneStatsEngine.upsertDriverPresence`).

### `staging_zones`
- **Purpose:** queue/staging geometry + display flags.
- **Cols:** `active`, `is_coming_soon`, `visible_to_drivers`, `lat/lng`, `radius_meters`,
  `circle_enabled` (005), `drawn_polygon`, `driven_polygon`, `use_driven_polygon`.
- **RLS:** public read + admin write (008:12-26). **Risk:** no name-based test filter.

### `work_areas` (010)
- **Purpose:** working-vs-passive polygon. **Cols:** `name`, `polygon jsonb`, `active`,
  `created_by`. **RLS:** read all + admin write. **Risk:** failure to load is fail-closed/silent.

### `zone_stats`
- **Purpose:** **display cache** (no longer source of truth). **PK:** `zone_id`.
- **Cols:** legacy `cars_staged/flow_rate_per_hour/wait_time_minutes/last_updated` + enriched (011):
  `smoothed_service_rate_per_hour`, `median_dwell_minutes`, `dwell_sample_size`,
  `estimated_wait_minutes/min/max`, `wait_confidence`, `wait_status`.
- **Risk:** legacy `increment_zone_count`/`decrement_zone_count` (002) still exist but **deprecated**
  (note in 011) — must not be used for live counts.

### `zone_visits`
- **Purpose:** per-visit dwell + features + classification. **PK:** `id`. **FKs:** drivers, staging_zones.
- **Cols:** `entered_at/exited_at`, `dwell_seconds`, speeds, `heading_change`, `forward_creep`,
  `confidence_score`, `classification`, `driver_confirmed`, `confirmed_label`.
- **dwell:** computed app-side at exit (`geofenceEngine handleExit`), no DB trigger.
- **classification casing:** lower-case `'staging'` from client; RPC uses `lower(classification)`
  (012:188) to be robust.
- **RLS:** `visits self`.

### `zone_departures` (phase5)
- **Purpose:** departure log feeding flow/service-rate. **Cols:** `zone_id`, `departed_at`.
  Index `(zone_id, departed_at desc)`. **Risk:** only populated if app logs departures.

### `trajectories`
- **Purpose:** raw GPS history + AI classification per visit. Unique `visit_id` (phase5).
  Written atomically with classification by `finalize_visit_classification` (013).

### `driver_zone_history`, `notifications`, `reference_routes` (009),
### `zone_config_versions` (015), `zone_audit_log` (004)
- History aggregates, push log + cooldowns, ML training routes, immutable zone snapshots, and
  change audit respectively. All admin/self RLS as appropriate.

---

## 2. RPC functions

| Function | Source | Notes |
|---|---|---|
| `get_zone_live_stats()` | 012:103-300 | STABLE SECURITY DEFINER; computes cars_staged, smoothed rate, median dwell, blended wait, confidence/status; `last_updated=now()`. Grant: authenticated, anon. |
| `upsert_driver_presence(...)` | 012:18-71 | SECURITY DEFINER; ownership-checked; normalizes bad classification→ACTIVE; **whitelist omits EXIT_GRACE in 012**, added in 014. Grant: authenticated. |
| `clear_driver_presence(uuid)` | 012:74-95 | Sets zone null + classification ACTIVE. Ownership-checked. |
| `finalize_visit_classification(...)` | 013:20-66 | Atomic trajectory + zone_visits update; ownership-checked. |
| `increment_zone_count`/`decrement_zone_count` | 002:40-86 | **DEPRECATED** (note in 011). |
| `soft_delete_driver` | 006/017 | Scrubs PII, sets status `off_duty`, deletion_status. |
| `cancel_account_deletion` | 017 | Idempotent; only when `scheduled_for_deletion`. |

## 3. Migration review (chronological highlights)

1. schema.sql — Phase 1 base; `status default 'browsing'` (later corrected by 001).
2. 001 — auth columns; migrate browsing→off_duty; first status CHECK (3 values); RLS.
3. 002 — zone improvements; legacy counters; stale-visit finalizers.
4. 003 — zones snapshot storage.
5. 004 — zone_audit_log.
6. 005 — `circle_enabled`.
7. 006 — account lifecycle, soft delete, `deleted_at is null` RLS.
8. 007 — drop drivers→auth FK constraint variant.
9. 008 — admin write policies for zones/zone_stats.
10. 009 — reference_routes (ML).
11. 010 — work_areas + driver gps_tier/work_area times.
12. 011 — **presence-based stats**: driver_presence, active_driver_presence view, get_zone_live_stats,
    enriched zone_stats columns; deprecate counters.
13. 012 — **secure** upsert/clear; casing-robust dwell filter.
14. 013 — atomic `finalize_visit_classification`.
15. 014 — **background tracking states**: widen status CHECK (7), default tracking_disabled, add
    `work_area_exit_started_at`, add EXIT_GRACE to classification + upsert whitelist, reaffirm view.
16. 015 — zone_config_versions.
17. 016 — driver taxi_company.
18. 017 — account deletion flow (status, token, scheduling).
19. phase5 — zone_departures + RLS, trajectories unique, push_token/device_platform.

## 4. Conflicts / risks found

1. **schema.sql default `browsing`** violates CHECK if applied standalone post-001. (MEDIUM)
2. **Soft-delete RLS gap** — `deleted_at is null` only in USING; deleted driver can UPDATE. (HIGH)
3. **`driver_presence` all-read** exposes live lat/lng to any authenticated user. (HIGH privacy)
4. **Migration-order sensitivity** for EXIT_GRACE whitelist (012 vs 014). (LOW if applied in order)
5. **Deprecated counters still present** — risk of accidental use. (LOW)
6. **No DB trigger for `dwell_seconds`/`zone_departures`** — depends on the client; missing client
   writes silently degrade wait/flow. (MEDIUM)
7. **schema.sql divergence** from migrations (columns only in migrations). Documented but a footgun
   for fresh setups. (MEDIUM)
8. **`get_zone_live_stats` filters `active` not `is_coming_soon`** — coming-soon+active would emit
   rows. (LOW, depends on data convention)

## 5. Verification SQL

```sql
-- Current status CHECK constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = 'drivers_status_check';

-- driver_presence classification constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = 'driver_presence_classification_check';

-- active_driver_presence view definition
SELECT pg_get_viewdef('active_driver_presence'::regclass, true);

-- Grants on the presence RPCs / live stats
SELECT routine_name, grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_name IN ('get_zone_live_stats','upsert_driver_presence','clear_driver_presence');

-- RLS policies on key tables
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies WHERE tablename IN ('drivers','driver_presence','staging_zones','zone_stats');

-- One driver's full live state
SELECT d.id, d.status, d.current_zone_id, d.tracking_enabled,
       p.current_zone_id AS p_zone, p.classification, p.last_ping_at
FROM drivers d LEFT JOIN driver_presence p ON p.driver_id = d.id
WHERE d.id = :driver;

-- One zone's live count path
SELECT * FROM get_zone_live_stats() WHERE zone_id = :zone;
```
