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

### Validation Still Requiring Real Devices

- Native geofence Enter/Exit behavior with nearest-20 monitoring.
- Background/force-close heartbeat freshness and stale cleanup timing.
- Offline ambiguous-visit confirmation replay after reconnect.
- Cached-stats degraded banner under real network/RPC failure.
- Corrupt polygon behavior in a deployed build with production zone data.
