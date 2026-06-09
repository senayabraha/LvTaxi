# Session handoff — LV Taxi eligibility/counting hardening

Living context for continuing work in a new session. Update as things change.
Last updated: 2026-06-09.

## Where things stand (done & live)

**P0 — Issues 1–5 + Phase 0 security: COMPLETE, merged to `main`, applied to prod DB.**

- **Phase 0 security** (migration `019`): dropped world-readable `all_read_presence`
  (own-row + admin read), revoked `anon` on `get_zone_live_stats`,
  `clear_driver_presence` refreshes `last_ping_at`.
- **Issue 1** — manual staging requires polygon confirmation. New
  `src/lib/polygonConfirmation.js` (fail-closed; tight `radius_meters` fallback,
  not flat 200 m), shared by `geofenceEngine.verifyWithPolygon` + `ImStagingButton`.
  Pure geo in `src/lib/geoMath.js`.
- **Issue 2** — `cars_staged` counts only confirmed `STAGING`; new
  `nearby_unconfirmed` counts `UNKNOWN` (migration `020`). JS mirror helpers in
  `constants.js`; UI shows "staged" + "+N nearby".
- **Issue 3** — accuracy + Android `mocked` gate. `MAX_PRESENCE_ACCURACY_METERS=50`
  in `constants.js`; pure `src/lib/presenceGate.js`; threaded through every
  heartbeat caller; `locationEngine` surfaces `loc.mocked`.
- **Issue 4** — one open `zone_visits` row per driver (migration `021`: unique
  partial index + idempotent `ensure_open_visit`). `transitionToStaged` is the sole
  visit owner and returns the visit id; geofence/poll/manual all route through it.
- **Issue 5** — server-side eligibility authority (migrations `022`+`023`): PostGIS
  `staging_zones.geom` (+ `max_accuracy_meters`), `upsert_driver_presence_validated`
  (recomputes true zone via `ST_Contains`, enforces accuracy ceiling),
  `eligible_driver_presence` view (9 conditions), `get_zone_live_stats.cars_staged`
  reads from it. Pure JS mirror: `src/lib/eligibility.js`.

**Two post-apply DB bug fixes (timestamped migrations, applied):**
- `20260608211308_fix_validated_presence_search_path.sql` — PostGIS lives in the
  `extensions` schema on Supabase, so functions calling `ST_*` need
  `SET search_path = public, extensions` (user fixed `022` the same way; I fixed
  `023`'s validated RPC + view).
- `20260609182035_fix_get_zone_live_stats_ambiguous_zone_id.sql` — `RETURNS TABLE`
  column names clashed with CTE columns; added `#variable_conflict use_column` +
  qualified refs.

**All branches merged into `main`** (P0 as the base; the other branches' transition
refactor/docs were already in `main` by content; only net-new was a
`TrackingDebugPanel` tweak). Every branch verified 0-ahead of `main`.

**DB verified healthy:** `get_zone_live_stats()` returns clean rows;
40/40 active zones have polygons; migration history reconciled (27 rows: `001`–`024`
+ baseline `20260606083233` + the two fixes).

## How Supabase deploys now (important)

- The **GitHub integration auto-applies `supabase/migrations/*.sql` to production on
  push to `main`.** History is reconciled, so it only runs genuinely-new migrations.
- **New migrations MUST use a 14-digit UTC timestamp prefix**
  (`YYYYMMDDHHMMSS_desc.sql`), later than baseline `20260606083233`. Numeric `NNN_`
  is refused (sorts before baseline). Documented in `CLAUDE.md` +
  `supabase/migrations/README.md`.
- PostGIS is in the `extensions` schema → any function/view using `ST_*` needs
  `extensions` on its search_path (and a session `SET search_path … extensions`
  for DDL that references `ST_*`).
- Append-only / non-destructive only. `supabase/schema.sql` is historical (not
  auto-applied). `002` contains a destructive `delete from staging_zones` — never
  let it replay.

## Open / pending

- **First push-to-main safety check (one-time):** confirm the integration reports
  nothing pending — especially `002` never "pending."
- **Rebuild/redeploy the mobile app** so drivers run the new client code (DB is ready).
- **P1 (not started):** Issue 6 centralized state machine + `driver_status_events`
  audit; Issue 7 device/session identity on `driver_presence`; Issue 8 immediate
  presence cleanup + pg_cron stale backstop; Issue 9 `driver_presence` realtime in
  `useZones`.
- **P2 (not started):** Issue 10 server-side clock-skew age; Issue 11 full per-zone
  config columns; Issue 12 min-dwell-before-count; Issue 13 geofence 20-region cap;
  Issue 14 materialized live stats (pg_cron, per user's choice).
- Decisions already made: PostGIS available; scheduler = **pg_cron**; conflict
  policy = **P0 as base**.

## Key files

- Plan: `LvTaxi_Implementation_Plan.md` (root). Model doc: `docs/eligibility-and-counting-model.md`.
- Migrations: `supabase/migrations/` (+ `README.md` convention).
- Core logic: `src/lib/{polygonConfirmation,presenceGate,eligibility,geoMath,
  presenceHeartbeat,geofenceEngine,driverStatusTransitions,zoneStatsEngine}.js`,
  `src/lib/backgroundTracking/*`, `src/hooks/useZones.js`,
  `src/components/{ImStagingButton,ZoneListItem,TrackingDebugPanel}.jsx`.
- Tests: `npm test` (jest-expo; node env; transforms `@turf`). 49 pure-logic tests in
  `src/lib/__tests__/`. Add tests for every pure-function change.

## Working conventions

- Work on `main` directly (per `CLAUDE.md`); commit + push when asked. Supabase
  project ref: `tcdrsuiemtktvtodypka`. The session DB is applied manually via SQL
  editor / auto via push; this container has no DB credentials or Supabase CLI.
