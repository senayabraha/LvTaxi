# Session Handoff - LV Taxi Eligibility/Counting Hardening

Living context for continuing work in a new session. Update as things change.
Last updated: 2026-06-10.

## Where Things Stand

P0, P1, P2, and P3 are complete on `main` as local commits. P2 was already
complete and merged before this session; P3 was completed in this session.

## Phase 0 / P0

- Security migration `019` locked down `driver_presence` reads to own-row/admin
  access, revoked anonymous execution of `get_zone_live_stats()`, and refreshed
  `last_ping_at` from `clear_driver_presence`.
- Manual staging, geofence staging, and polygon confirmation share
  `src/lib/polygonConfirmation.js`, with fail-closed polygon checks and a tight
  radius fallback for polygon-less zones.
- `cars_staged` counts confirmed `STAGING` only; `UNKNOWN` is reported as
  `nearby_unconfirmed`.
- Client GPS accuracy and Android mocked-location gates are in place.
- Staging entry is centralized around one open `zone_visits` row per driver.
- Server-side validated presence and eligibility were added with PostGIS
  geometry, `upsert_driver_presence_validated`, `eligible_driver_presence`, and
  a `get_zone_live_stats()` count path based on eligible presence.

## P1 / P2 State Before This Session

- P1 lifecycle/state-machine work is present in the repo: transition helpers,
  cleanup on sign-out, exit-grace visit closure, orphan-visit preservation,
  profile retry handling, stable launch-effect gating, transition audit table,
  and device/session metadata migrations.
- P2 migrations `019` through `027` were live before P3 started. The later
  timestamped migrations include stale-presence cleanup and
  `zone_live_stats_snapshot` with pg_cron refresh support.
- Test suite baseline before P3 was reported as 92 passing.

## P3 Completed In This Session

- **Issue 15 / DATA-1**: added
  `20260610130000_028_zone_visits_classification_check.sql`.
  Existing `zone_visits.classification` values are normalized to lowercase, then
  constrained to `staging`, `drop_off`, `passing`, `unknown`, or `abandoned`.
- **Issue 16 / DATA-2**: rewrote README setup instructions. New setup requires
  applying `supabase/migrations/` in filename order via `supabase db push` or the
  SQL editor. `supabase/schema.sql` is documented as historical only.
- **Issue 17 / DATA-3**: grep confirmed no app, admin, or Edge Function code
  reads `drivers.current_lat/current_lng`. Added
  `20260610131000_029_drop_deprecated_driver_location_columns.sql`, redefined
  `soft_delete_driver()` without the legacy columns, and dropped them.
- **Issue 18 / DATA-4**: added `SAVE_TRAINING_DATA` to the offline visit
  side-effect queue. Ambiguous-visit confirmation taps now replay on reconnect.
- **Issue 19 / RT-2 + RT-3**: legacy stats fallback is marked degraded and the
  driver sees "Showing cached stats — live data unavailable." Full snapshot/RPC
  stats loads now replace the stats map so omitted zones do not retain stale
  values.
- **Issue 20 / RT-5**: removed the dead queue-position UI path and the
  null-returning `getDriverPositionInZone()` export.
- **Issue 21 / GEO-3**: geofence monitoring now uses nearest physical zones
  regardless of active UI sort. Flow/Wait sorting remains UI-only.
- **Issue 22 / GEO-5**: geofence confirmation now uses
  `confirmStagingLocation()`, so malformed polygons fail closed and polygon-less
  zones use the same tight radius fallback as manual staging.

## Migration Notes

- New migrations must use 14-digit UTC timestamp prefixes:
  `YYYYMMDDHHMMSS_short_description.sql`.
- Numeric `001` through `024` are legacy migrations. Timestamped migrations from
  `025` onward are the live convention.
- P3 created timestamped migrations with human issue numbers in the filename:
  `_028_zone_visits_classification_check` and
  `_029_drop_deprecated_driver_location_columns`.
- `supabase/schema.sql` is historical and must not be used as current setup.
- PostGIS functions/views need `public, extensions` search paths where they call
  `ST_*`.

## Tests Added In P3

- `src/lib/__tests__/visitProcessorOfflineQueue.test.js`
- `src/store/__tests__/zonesSlice.test.js`
- `src/lib/__tests__/geofenceEngine.test.js`

Focused tests run during implementation:

- `npm.cmd test -- visitProcessorOfflineQueue.test.js --runInBand`
- `npm.cmd test -- zonesSlice.test.js --runInBand`
- `npm.cmd test -- geofenceEngine.test.js --runInBand`

Final full-suite result after P3: `npm.cmd test -- --runInBand` passed with
13 test suites and 100 tests. The count is higher than the pre-P3 92-test
baseline because P3 added 8 focused regression tests.

## Remaining Items Needing Real-Device Validation

- Native geofence Enter/Exit events after installing the updated client,
  especially nearest-20 monitoring independent of Flow/Wait sort.
- Malformed/corrupt polygon behavior cannot be staged as confirmed `STAGING`;
  drivers should fall back to unconfirmed/unknown behavior rather than being
  counted.
- Offline ambiguous-visit YES/NO confirmation while network is disabled, then
  reconnect and confirm the queued training side effect replays.
- Cached-stats degraded banner when snapshot/RPC live stats fail on device.
- Background and force-close behavior around presence freshness, stale-presence
  cleanup, and snapshot refresh timing.

## Working Conventions

- Work on `main` directly unless told otherwise.
- One logical issue per commit.
- Use append-only migrations only.
- Do not edit already-applied migrations or `supabase/schema.sql`.
- Commit and push only when requested. Supabase project ref:
  `tcdrsuiemtktvtodypka`.
