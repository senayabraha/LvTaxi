# Changelog

## 2026-06-10 - Eligibility, Counting, Realtime, and Hygiene Hardening

This entry summarizes the completed work from Phase 0 through P3.

### Phase 0 / P0

- Locked down live driver presence reads and removed anonymous live-stats RPC
  access.
- Standardized confirmed staging around polygon confirmation with a tight
  radius fallback for polygon-less zones.
- Split confirmed staged counts from nearby unconfirmed counts.
- Added GPS accuracy and Android mocked-location gates.
- Centralized staging entry so each driver has at most one open visit.
- Added server-side validated presence and eligibility through PostGIS,
  `upsert_driver_presence_validated`, `eligible_driver_presence`, and updated
  live-stats counts.

### P1 / P2

- Added transition/audit lifecycle infrastructure and device/session metadata.
- Improved sign-out cleanup, profile retry handling, exit-grace visit closure,
  and orphan-visit preservation.
- Added stale-presence cleanup and a live-stats snapshot table refreshed by
  pg_cron, with realtime subscription support.
- Preserved richer live stat fields against lean legacy realtime updates.

### P3

- Added migration `_028_zone_visits_classification_check` to normalize and
  constrain `zone_visits.classification`.
- Updated README database setup so new installs run migrations in order instead
  of using historical `supabase/schema.sql`.
- Added migration `_029_drop_deprecated_driver_location_columns` to redefine
  `soft_delete_driver()` and drop unused `drivers.current_lat/current_lng`.
- Added offline replay for ambiguous-visit training confirmations with
  `SAVE_TRAINING_DATA`.
- Marked legacy stats fallback as degraded and surfaced the driver banner:
  "Showing cached stats — live data unavailable."
- Replaced full stats snapshots instead of merging them, preventing omitted
  zones from retaining stale values.
- Removed the dead queue-position UI path.
- Made geofence monitoring select the nearest physical zones regardless of UI
  Flow/Wait sort.
- Standardized geofence polygon confirmation on fail-closed behavior through
  `confirmStagingLocation()`.

### P4

- Added device and session identity (LIFE-8). Migration `_030_device_session_identity`
  adds `device_id`, `session_id`, `app_version`, `platform` to `driver_presence`
  and `device_id`, `session_id` to `driver_status_events`. The updated
  `upsert_driver_presence_validated()` enforces last-session-wins: a heartbeat
  from a stale/backgrounded device whose `session_id` is lexically older than the
  stored one is silently ignored, eliminating status flap when two devices share
  one account.
- Added `src/lib/deviceIdentity.js`: stable `device_id` persisted to AsyncStorage,
  fresh `session_id` generated per launch with a timestamp prefix, and platform
  metadata accessors. No new npm dependencies.
- Threaded `device_id`, `session_id`, `app_version`, and `platform` through
  `upsertDriverPresence` and `maybeSendPresenceHeartbeat` so every heartbeat
  write carries full identity context.
- Confirmed Android mocked-location gate (SEC-5) fully implemented: `locationEngine`
  extracts `loc.mocked`, `presenceGate.isFixAcceptableForPresence` rejects
  `mocked === true` before the throttle window, no code change required.
- Confirmed all production readiness checks against live Supabase project: four
  pg_cron jobs active, all three realtime tables published, `eligible_driver_presence`
  compiles, snapshot table populated with 40 rows, all active staging zones have
  PostGIS geometry.
- Added `docs/real-device-test-plan.md` with 10 structured scenarios covering
  background geofence launch, permission banner, force-close staleness,
  zone-to-zone throttle reset, duplicate device session, manual staging polygon
  validation, Android mock GPS, offline confirmation replay, cached-stats banner,
  and nearest-20 geofence monitoring.

### Validation Still Requiring Real Devices

See `docs/real-device-test-plan.md` for the full checklist. Key open items:

- GEO-1: cold background relaunch — geofence Enter fires and creates a
  `zone_visits` row without opening the app.
- Background "While Using" permission — degraded banner appears, driver drops
  from count within 90 s of backgrounding.
- Force-close staleness — freshness label ages, driver expires within 90 s.
- Zone A → Zone B within 25 s — presence updates immediately (throttle reset).
- Duplicate device — only one counted, newer `session_id` wins.
- Manual staging polygon — rejected outside, accepted inside.
- Android mock GPS — driver not counted as STAGING.
- Offline ambiguous-visit confirmation replay after reconnect.
- Cached-stats degraded banner under real RPC failure.
- Nearest-20 geofence fires for the physically closest zone regardless of UI sort.
