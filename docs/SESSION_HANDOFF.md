# Session Handoff - LV Taxi Eligibility/Counting Hardening

Living context for continuing work in a new session. Update as things change.
Last updated: 2026-06-10.

## Where Things Stand

P0, P1, P2, P3, and P4 are complete on `main` as local commits. The codebase is
ready for a real-device test build. See `docs/real-device-test-plan.md` for the
10-scenario validation checklist.

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

## P1 / P2 State

- P1 lifecycle/state-machine work is present in the repo: transition helpers,
  cleanup on sign-out, exit-grace visit closure, orphan-visit preservation,
  profile retry handling, stable launch-effect gating, transition audit table,
  and device/session metadata migrations.
- P2 migrations `019` through `027` were live. The later timestamped migrations
  include stale-presence cleanup and `zone_live_stats_snapshot` with pg_cron
  refresh support.
- Test suite baseline before P3 was 92 passing.

## P3 Completed

- **DATA-1**: migration `_028_zone_visits_classification_check` — normalize and
  constrain `zone_visits.classification`.
- **DATA-2**: README setup rewritten — run migrations in order, not schema.sql.
- **DATA-3**: migration `_029_drop_deprecated_driver_location_columns` — drop
  `drivers.current_lat/current_lng`.
- **DATA-4**: `SAVE_TRAINING_DATA` offline queue — ambiguous-visit confirmations
  replay on reconnect.
- **RT-2 + RT-3**: degraded banner ("Showing cached stats — live data
  unavailable.") + full stats replacement (no stale zones).
- **RT-5**: dead queue-position UI removed.
- **GEO-3**: geofence monitoring selects nearest 20 physical zones regardless of
  UI sort.
- **GEO-5**: geofence polygon confirmation delegates to `confirmStagingLocation()`
  (fail-closed).

## P4 Completed In This Session

- **Issue 23 / LIFE-8**: Device and session identity.
  - Migration `20260610140000_030_device_session_identity.sql` adds `device_id`,
    `session_id`, `app_version`, `platform` to `driver_presence` (nullable, fully
    backward-compatible) and `device_id`, `session_id` to `driver_status_events`.
  - `upsert_driver_presence_validated()` updated to accept the four new parameters
    (DEFAULT NULL) and enforces **last-session-wins**: if the stored `session_id`
    is lexically later than the incoming one, the write is silently ignored and
    the stored `last_ping_at` is returned. Lexical order == chronological order
    because `session_id` is `YYYYMMDDTHHMMSS_<random>`.
  - `src/lib/deviceIdentity.js` created: `SESSION_ID` (fresh per launch, exported
    constant) and `getDeviceId()` (stable per device, persisted to AsyncStorage).
    Uses `expo-device` for model info; no new npm dependencies.
  - `upsertDriverPresence()` in `zoneStatsEngine.js` accepts and forwards the
    four identity fields.
  - `maybeSendPresenceHeartbeat()` in `presenceHeartbeat.js` resolves identity
    via `getDeviceId()` and forwards all four fields on every heartbeat write.

- **Issue 24 / SEC-5**: Android mocked-location gate — confirmed already fully
  implemented in P0/P2. No code change needed.
  - `locationEngine.js`: extracts `mocked` from `loc.mocked === true`.
  - `presenceGate.js`: `isFixAcceptableForPresence` rejects `mocked === true`
    before the throttle window, so a mock fix never reaches the RPC.
  - `presenceHeartbeat.js`: passes `mocked` through to the gate on every fix.

- **Issue 25 / Production readiness** — all checks passed against live DB:
  - pg_cron: 4 jobs running (`lvtaxi_clear_stale_presence`,
    `lvtaxi_refresh_zone_snapshot`, `lvtaxi_finalize_unknown`,
    `lvtaxi_close_stale_visits`).
  - Realtime publication: `zone_stats`, `driver_presence`,
    `zone_live_stats_snapshot` all present.
  - `eligible_driver_presence` view compiles and returns (0 rows, no drivers
    staged in the empty test environment).
  - `zone_live_stats_snapshot`: 40 rows populated by pg_cron.
  - Polygon coverage: 0 active zones with `geom IS NULL` (all zones have
    PostGIS geometry).

- **Issue 26**: `docs/real-device-test-plan.md` written — 10 scenarios covering
  GEO-1 cold background launch, background permission banner, force-close
  staleness, zone A→B throttle reset, duplicate device, manual staging polygon
  reject/accept, Android mock location, offline confirmation replay, cached-stats
  banner, and nearest-20 geofence monitoring.

## Migration Notes

- New migrations must use 14-digit UTC timestamp prefixes:
  `YYYYMMDDHHMMSS_short_description.sql`.
- Numeric `001` through `024` are legacy migrations. Timestamped migrations from
  `025` onward are the live convention.
- PostGIS functions/views need `public, extensions` search paths where they call
  `ST_*` (learned from migration 030 apply).
- `supabase/schema.sql` is historical and must not be used as current setup.

## Tests After P4

Full suite: `npm.cmd test -- --runInBand` → **13 suites, 100 tests, all passing.**
No new tests were added in P4 (the identity plumbing is thin glue with no logic
to unit-test; coverage lives in the DB migration and real-device scenarios).

## Remaining Items — Real-Device Only

See `docs/real-device-test-plan.md` for the full 10-scenario checklist. Key items:

1. GEO-1: cold background relaunch geofence Enter → `zone_visits` row without
   opening the app.
2. Background permission "While Using" → degraded banner + driver drops from count
   after 90 s backgrounded.
3. Force-close staleness: freshness label ages; driver drops within 90 s.
4. Zone A → Zone B within 25 s: presence updates immediately (throttle reset).
5. Duplicate device: only one counted, newer `session_id` wins.
6. Manual staging polygon: rejected from outside, accepted from inside.
7. Android mock GPS: driver NOT counted as STAGING.
8. Offline confirmation replay after reconnect.
9. Cached-stats degraded banner under real RPC failure.
10. Nearest-20 geofence fires for the physically closest zone regardless of UI sort.

## Working Conventions

- Work on `main` directly unless told otherwise.
- One logical issue per commit.
- Use append-only migrations only.
- Do not edit already-applied migrations or `supabase/schema.sql`.
- PostGIS functions need `SET search_path = public, extensions`.
- Commit and push only when requested. Supabase project ref:
  `tcdrsuiemtktvtodypka`.
