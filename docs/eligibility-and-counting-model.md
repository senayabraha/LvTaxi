# Eligibility, Counting & Staging Model (P0)

This note documents the P0 hardening of the driver-status / zone-count /
eligibility / geospatial subsystems (fix-prompt Issues 1–5). The **server is the
counting authority**; the client proposes, the backend disposes.

## TL;DR

- A driver is counted in a zone **only when the backend confirms it** via
  `eligible_driver_presence` (PostGIS `ST_Contains` + 8 other conditions).
- `cars_staged` = confirmed `STAGING` only. `UNKNOWN` presence is reported
  separately as `nearby_unconfirmed` ("nearby"), never as staged.
- Every staged promotion — geofence, background poll, or the manual button —
  yields **exactly one open `zone_visits` row** via `ensure_open_visit`.
- Coarse (> 50 m) or **mocked** GPS fixes never count.

## The 9-condition eligibility rule

A driver counts toward a zone iff ALL hold (SQL: `eligible_driver_presence`,
migration 023; JS mirror: `src/lib/eligibility.js`):

1. `drivers.tracking_enabled = true`
2. `drivers.status = 'staged'`
3. account active (`drivers.deleted_at IS NULL`)
4. `driver_presence.current_zone_id` is set
5. `driver_presence.classification = 'STAGING'`
6. fresh ping — `last_ping_at` within `PRESENCE_TTL_SECONDS` (90 s)
7. accuracy within the ceiling — `accuracy <= COALESCE(staging_zones.max_accuracy_meters, 50)`
8. the zone has a polygon (`staging_zones.geom IS NOT NULL`)
9. `ST_Contains(zone.geom, point)` — the stored coordinates are genuinely inside
   that zone's polygon

The validated write RPC `upsert_driver_presence_validated()` **recomputes the
true zone from the coordinates** (smallest containing polygon) instead of
trusting the client's claimed `current_zone_id`, and only stamps `STAGING` when
the point is inside an active polygon with an acceptable fix. Otherwise it writes
`UNKNOWN` (near) or `ACTIVE` (null zone). A spoofed/drifted client can no longer
claim `STAGING` anywhere.

> **Rollout note:** confirmed staging now requires the zone to have a polygon
> (`geom`). Polygon-less zones can only ever be `UNKNOWN`/"nearby". Backfill is
> automatic from `drawn_polygon`/`driven_polygon` and a trigger keeps `geom` in
> sync; **zones without a polygon must have one drawn** to count drivers.

## Single staging entry path (one visit)

`transitionToStaged(driverId, zoneId)` is the one owner of the visit row. It
calls `ensure_open_visit` (idempotent, ownership-checked, backed by the unique
partial index `one_open_visit_per_driver`) and returns the open `visitId`. All
three callers consume it instead of inserting their own:

- `geofenceEngine.completeHandleEnter` (native geofence + polygon refine)
- `backgroundTracking/activeLocationTask` (polygon poll)
- `components/ImStagingButton` (manual "I'm Staging")

This fixes counted-but-no-dwell (poll path) and duplicate visits (manual taps /
path overlap). Robust exit/dwell-close for the poll path is scheduled for Issue 8.

## Shared polygon confirmation (client)

`src/lib/polygonConfirmation.js` is the single fail-closed implementation used by
both the geofence path and the manual button:

- zone has a polygon → must contain the point (`@turf/booleanPointInPolygon`);
  a malformed polygon confirms nothing (fail-closed).
- polygon-less zone → tight centre-radius using the zone's real `radius_meters`,
  capped at 120 m — never the old flat 200 m (which dwarfs the 40–80 m lanes).

## GPS accuracy / anti-spoof gate (client + server)

- Client: `src/lib/presenceGate.js` drops a heartbeat whose accuracy is worse
  than `MAX_PRESENCE_ACCURACY_METERS` (50 m) and rejects Android mock locations
  (`expo-location` `LocationObject.mocked`).
- Server: the eligibility view re-enforces the per-zone accuracy ceiling, so a
  tampered client cannot bypass it.

## Per-zone configuration

`staging_zones` gained (migration 022):

| Column | Meaning | Default |
| --- | --- | --- |
| `geom geometry(Geometry,4326)` | PostGIS polygon for `ST_Contains` | backfilled from GeoJSON |
| `max_accuracy_meters int` | per-zone GPS-accuracy ceiling | `NULL` → global 50 m |

Airport lanes can tighten `max_accuracy_meters`; large lots can relax it. The
broader per-zone rule set (`min_dwell_seconds_before_count`,
`requires_polygon_confirmation`, `stale_after_seconds`) lands in Issue 11.

## Single source of truth for tunables

`src/lib/constants.js` holds the JS tunables with the SQL value documented
alongside:

- `PRESENCE_TTL_SECONDS = 90` (mirrored in the view / RPC)
- `MAX_PRESENCE_ACCURACY_METERS = 50` (mirrored as `COALESCE(max_accuracy_meters, 50)`)
- `WORK_AREA_EXIT_GRACE_MS = 30 min`

## Migrations added (on top of 019)

| # | Purpose | Issue |
| --- | --- | --- |
| 020 | split live counts: `cars_staged` (STAGING) + `nearby_unconfirmed` (UNKNOWN) | 2 |
| 021 | `one_open_visit_per_driver` index + `ensure_open_visit()` | 4 |
| 022 | PostGIS: `geom`, `max_accuracy_meters`, backfill + sync trigger + GIST index | 5 |
| 023 | `upsert_driver_presence_validated()`, `eligible_driver_presence`, repoint counts | 5 |

All are append-only and backward compatible: the client prefers the new RPCs and
falls back (`isMissingFunctionError`) to the legacy ones, so the app runs whether
or not the migrations have been applied.

## Tests (`npm test`)

`behavioralClassifier` (70/20 thresholds), `polygonConfirmation`,
`presenceGate` (accuracy/mock), `countingReconciliation` (STAGING vs UNKNOWN),
`eligibility` (all 9 conditions + boundaries), `freshnessBoundaries`
(90 s TTL + 30 min grace). 49 cases.

## Still open (P1/P2 — deferred per "P0 first" plan)

Issues 6 (centralized state machine + audit), 7 (device/session identity),
8 (immediate cleanup + pg_cron backstop), 9 (driver_presence realtime),
10 (server-side clock-skew age), 11 (full per-zone rules), 12 (min-dwell),
13 (geofence 20-region cap), 14 (materialized live stats).
