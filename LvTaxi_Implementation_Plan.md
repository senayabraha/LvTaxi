# LV Taxi — Master Implementation Plan & Claude Code Prompt

Consolidated from four independent code reviews (two structural audits + two functional audits) of `senayabraha/LvTaxi`. Every issue is deduplicated, severity-ranked, and anchored to real files/functions/migrations.

**The single most urgent item is SEC-1 (a live-location privacy leak exploitable today with one `SELECT`). It is independent of every functional bug and should ship before anything else.**

---

## Issue Index (deduplicated, severity-ranked)

| ID | Title | Priority | Complexity | Phase |
|----|-------|----------|-----------|-------|
| SEC-1 | `driver_presence` world-readable (all driver coordinates) | Critical | Small | 0 |
| SEC-2 | `get_zone_live_stats()` granted to `anon` | Medium | Small | 0 |
| SEC-3 | Backend trusts client-claimed zone/classification (no geospatial validation) | Critical | Large | 2 |
| SEC-4 | No GPS-accuracy gate (client + SQL) | High | Medium | 2 |
| SEC-5 | No mock-location / impossible-movement detection | High | Medium | 2 |
| CNT-1 | `transitionToStaged` creates no `zone_visits` → staged-without-visit | Critical | Large | 1 |
| CNT-2 | Three divergent staging paths (geofence / manual / active task) | Critical | Large | 1 |
| CNT-3 | SQL counts `UNKNOWN` as staged | High | Medium | 1 |
| CNT-4 | Presence counted with `active_visit_id = NULL` | Medium | Small | 1/2 |
| CNT-5 | Manual button can create duplicate open visits | Medium | Small | 1 |
| CNT-6 | Staging side effects can double-count departures | Medium | Medium | 1 |
| CNT-7 | Realtime overwrites live `cars_staged` with stale legacy value | Medium | Small | 5 |
| GEO-1 | Geofence task not registered at top-level (background/headless dropped) | Critical | Small | 3 |
| GEO-2 | Polygon-less zones counted (80 m circle / 200 m center / manual distance) | High | Medium | 1/2 |
| GEO-3 | iOS 20-geofence cap + sort-based selection misses nearest zones | High | Medium | 3 |
| GEO-4 | Geofence recompute reacts to stats keys, not values | Medium | Small | 3 |
| GEO-5 | `verifyWithPolygon` fails open; `workAreaGeometry` fails closed | Medium | Small | 3 |
| GEO-6 | Active task can stage a driver outside the work area | Low | Small | 3 |
| LIFE-1 | Two parallel state machines (`tierManager` vs background tasks) clobber columns | High | Large | 4 |
| LIFE-2 | Heartbeat throttle never reset (`resetPresenceHeartbeat` is dead code) | High | Small | 1 |
| LIFE-3 | `SIGNED_OUT` event doesn't clear presence / stop tasks | Medium | Small | 4 |
| LIFE-4 | Profile-fetch failure strands logged-in driver on login screen | High | Small | 4 |
| LIFE-5 | Reconciliation re-runs on every `TOKEN_REFRESHED` | Medium | Small | 4 |
| LIFE-6 | Geofence exit clears presence only if a `visitId` exists | High | Medium | 1 |
| LIFE-7 | Exit-grace doesn't close an open `zone_visits` row | Medium | Small | 4 |
| LIFE-8 | No `device_id`/`session_id` → duplicate-device clobber | Medium | Medium | 4 |
| LIFE-9 | `closeOrphanedVisits` can close an in-progress visit on relaunch | Medium | Medium | 4 |
| LIFE-10 | No background-permission verification before counting | High | Small | 3 |
| LIFE-11 | `clear_driver_presence` doesn't refresh `last_ping_at` | Low | Small | 0 |
| RT-1 | Realtime listens to `zone_stats`, not `driver_presence` | High | Medium | 5 |
| RT-2 | Legacy-stats fallback shows stale count with no degraded warning | Medium | Small | 5 |
| RT-3 | `mergeLiveStats` doesn't prune zones missing from the RPC | Low | Small | 5 |
| RT-4 | Force-close → silent drop; no last-heartbeat staleness UI | Medium | Small | 3 |
| RT-5 | Dead queue-position feature wired into the UI | Low | Small | 4 |
| SCALE-1 | Heavy `get_zone_live_stats` recomputed by every client poll | High | Medium | 5 |
| DATA-1 | `zone_visits.classification` has no CHECK; mixed casing | Low | Small | 6 |
| DATA-2 | README setup instructions are wrong/incomplete | Low | Small | 6 |
| DATA-3 | Dead `drivers.current_lat/current_lng` columns | Low | Small | 6 |
| DATA-4 | Training-data confirmation not offline-queued | Low | Small | 6 |
| OPS-1 | No server-side stale-presence cleanup backstop | Medium | Small | 5 |
| QA-1 | No automated tests for any of the above | High | Large | all |

---

# Part 1 — Actionable Fix Plan

Work proceeds in phases. Each phase is independently shippable. **Phase 0 is a same-day hotfix.** Phases 1–2 fix correctness/security; 3–4 fix reliability/lifecycle; 5–6 fix scale, UX, and hygiene. QA work (Phase 7) is woven through every phase.

## Global constraints (apply to every change)

- **Migrations are append-only.** Add new numbered files (`019_…`, `020_…`). Use `CREATE OR REPLACE`, `IF NOT EXISTS`, additive `ALTER`. Never edit `001`–`018` or `schema.sql`.
- **Backward compatible.** Keep existing JS signatures working; the app must run if a new migration isn't applied yet (mirror `isMissingFunctionError` in `visitProcessor.js`).
- **Single source of truth for tunables** in `src/lib/constants.js`, with the SQL value documented beside it (as the 90 s TTL already is).
- **Preserve** existing RLS ownership checks, `SECURITY DEFINER` + `auth.uid()` guards, and the offline replay design.

---

## Phase 0 — Security & cheap-correctness hotfix (ship first)

### SEC-1 — `driver_presence` exposes every driver's live coordinates
- **Problem:** Migration 011 creates `CREATE POLICY all_read_presence ON driver_presence FOR SELECT USING (true)`. The table holds per-driver `lat/lng/speed/heading`. Any authenticated user can `select * from driver_presence` and read everyone's real-time location.
- **Why it matters:** Live-location privacy/legal exposure (the repo ships `legal/PRIVACY.md`). Exploitable today, independent of any functional bug.
- **Where:** `supabase/migrations/011_presence_based_zone_stats.sql` (policy `all_read_presence`); consumers `zoneStatsEngine.fetchLiveZoneStats` (already uses the RPC, not the table).
- **Fix:** Drop the public SELECT policy. Drivers read only their own row; aggregate counts come exclusively from the `SECURITY DEFINER` RPC (`get_zone_live_stats`), which never returns coordinates.
- **Steps:**
  1. New migration `019_lock_down_presence_reads.sql`:
     ```sql
     DROP POLICY IF EXISTS all_read_presence ON driver_presence;
     CREATE POLICY drivers_read_own_presence ON driver_presence
       FOR SELECT USING (auth.uid() = driver_id);
     -- (optional) admin read:
     CREATE POLICY admins_read_presence ON driver_presence
       FOR SELECT USING (EXISTS (SELECT 1 FROM drivers d
         WHERE d.id = auth.uid() AND d.role = 'admin'));
     ```
  2. Confirm no client code does a direct `from('driver_presence').select()` for counts (grep). The live read path is the RPC, so this is non-breaking.
- **Testing:** As driver A, attempt `supabase.from('driver_presence').select('*')` → returns only A's row (or none). `get_zone_live_stats()` still returns correct counts. Admin (if added) can read all.
- **Priority:** Critical · **Complexity:** Small

### SEC-2 — `get_zone_live_stats()` granted to `anon`
- **Problem:** Granted to `authenticated, anon` in 011/012.
- **Why it matters:** Anonymous users can pull operational queue intelligence.
- **Where:** `supabase/migrations/011/012`.
- **Fix:** In `019`, `REVOKE EXECUTE ON FUNCTION get_zone_live_stats() FROM anon;` unless a public marketing display is intended (decide explicitly).
- **Testing:** Unauthenticated RPC call → permission denied; authenticated → works.
- **Priority:** Medium · **Complexity:** Small

### LIFE-11 — `clear_driver_presence` doesn't refresh `last_ping_at`
- **Problem:** Sets `current_zone_id=NULL, classification='ACTIVE', updated_at=now()` but not `last_ping_at`.
- **Why it matters:** Doesn't break counts (null zone removes the driver) but rows look stale in debugging/admin.
- **Where:** `supabase/migrations/012` `clear_driver_presence`.
- **Fix:** Add `last_ping_at = now()` to the UPDATE in `019` (`CREATE OR REPLACE`).
- **Testing:** Call `clear_driver_presence`; row's `last_ping_at` is fresh, zone null, not counted.
- **Priority:** Low · **Complexity:** Small

---

## Phase 1 — Counting correctness & centralized staging (the core)

This phase introduces one authoritative staging entry/exit path and fixes the count rule. It resolves CNT-1, CNT-2, CNT-4 (partial), CNT-5, CNT-6, GEO-2 (client side), LIFE-2, LIFE-6.

### CNT-1 + CNT-2 — Centralize staging; guarantee a `zone_visits` row
- **Problem:** `transitionToStaged()` only writes Redux + `drivers` + starts tracking; it never creates a `zone_visits` row or starts trajectory recording. `geofenceEngine.completeHandleEnter` and `ImStagingButton` *do* create visits; `activeLocationTask`/`passiveLocationTask` do *not*. So a driver staged by the background task is counted but produces no dwell history.
- **Why it matters:** Live `cars_staged` and the wait-time model disagree. `median_dwell_minutes` (the dominant wait input) is starved in normal backgrounded use, so the app's headline number is unreliable exactly when drivers rely on it.
- **Where:** `src/lib/driverStatusTransitions.js` (`transitionToStaged`); `src/lib/geofenceEngine.js` (`completeHandleEnter`, `registerActiveVisit`, `handleExit`); `src/components/ImStagingButton.jsx` (`stageAt`); `src/lib/backgroundTracking/activeLocationTask.js`, `passiveLocationTask.js`; `src/lib/trajectoryRecorder.js`; tables `zone_visits`, `driver_presence`.
- **Fix:** Create one function `enterStagingZone({ driverId, zoneId, source, lat, lng, accuracy, speed, heading })` in a new `src/lib/stagingService.js` that: (1) validates polygon + accuracy (see GEO-2/SEC-4), (2) ensures exactly one open `zone_visits` row for the driver (idempotent upsert), (3) `registerActiveVisit`, (4) `startRecording`, (5) sets Redux + `drivers.status/current_zone_id`, (6) writes presence with `active_visit_id`, (7) audits the transition (LIFE-8 audit table). Replace the staging logic in all four callers with a call to it.
- **Steps:**
  1. Add `019`/`020` unique partial index: `CREATE UNIQUE INDEX IF NOT EXISTS one_open_visit_per_driver ON zone_visits(driver_id) WHERE exited_at IS NULL;`
  2. Add an `ensure_open_visit(p_driver_id, p_zone_id)` RPC (SECURITY DEFINER, ownership-checked) that `INSERT … ON CONFLICT DO NOTHING` against that index and returns the open visit id.
  3. Implement `stagingService.enterStagingZone()` calling `ensure_open_visit` then the existing recording/presence helpers.
  4. Refactor `completeHandleEnter`, `stageAt`, and the staging branches of `activeLocationTask`/`passiveLocationTask` to call it; delete their bespoke insert/transition code.
  5. Keep `transitionToStaged` as a thin internal step used *by* `enterStagingService`, not called directly elsewhere.
- **Testing:** Unit: each entry path produces exactly one open visit and a presence row with `active_visit_id`. Integration: stage via active-task simulation → a completed visit with `dwell_seconds` appears after exit and feeds `median_dwell_minutes`.
- **Priority:** Critical · **Complexity:** Large

### CNT-3 — SQL counts `UNKNOWN` as staged
- **Problem:** `get_zone_live_stats` live-count CTE and `active_driver_presence` view count `classification IN ('STAGING','UNKNOWN')`; the client predicate `countsInStagingMath()` says STAGING only.
- **Why it matters:** Drivers merely *near* a zone inflate the count; client and server disagree on the rule.
- **Where:** `supabase/migrations/011/012/014`; `src/lib/constants.js`.
- **Fix:** New migration `CREATE OR REPLACE` of `get_zone_live_stats` and the view: count only `STAGING` for `cars_staged`; add a separate `nearby_unconfirmed` count for `UNKNOWN`. Return both. Update `zonesSlice`/`ZoneListItem` to show "Confirmed staged" and "Nearby".
- **Steps:** (1) New migration restating the function with the split counts. (2) Extend the RPC return shape + `ZoneStat` type. (3) Render both lines.
- **Testing:** SQL test fixtures: one STAGING + one UNKNOWN in a zone → `cars_staged=1`, `nearby_unconfirmed=1`.
- **Priority:** High · **Complexity:** Medium

### CNT-5 — Manual button duplicate visits
- **Problem:** `stageAt()` always inserts a new `zone_visits` row; no open-visit check.
- **Why it matters:** Multiple taps / overlap with geofence path create duplicate open visits → inflated departures/history.
- **Where:** `ImStagingButton.jsx`.
- **Fix:** Resolved by routing through `enterStagingZone` + the unique partial index from CNT-1.
- **Testing:** Tap "I'm Staging" 5× rapidly → one open visit.
- **Priority:** Medium · **Complexity:** Small

### CNT-6 — Side effects can double-count departures
- **Problem:** `applyStagingSideEffects` records a load event + history; duplicate visits or double exit processing inflate `zone_departures`/history.
- **Why it matters:** Corrupts flow rate and the queue-wait estimate.
- **Where:** `src/lib/visitProcessor.js`; table `zone_departures`.
- **Fix:** Add `zone_departures.visit_id` with `UNIQUE`, and make `record_load_event` / departure inserts reference the visit so a replay/dup can't double-insert. Drive history increments from a processed-visit flag.
- **Steps:** Migration adds nullable `visit_id uuid REFERENCES zone_visits(id)` + unique index; update `record_load_event` and `applyStagingSideEffects` to pass and dedupe on it.
- **Testing:** Process the same visit twice → exactly one departure row.
- **Priority:** Medium · **Complexity:** Medium

### LIFE-2 — Heartbeat throttle never reset
- **Problem:** `lastHeartbeatAt` is module-level; `resetPresenceHeartbeat()` exists but has **zero callers**. A zone A→B move inside the 25 s window is throttled (active-task heartbeat is unforced) → presence keeps the old zone.
- **Why it matters:** Wrong zone attribution; the driver counts in A while parked in B.
- **Where:** `src/lib/presenceHeartbeat.js`; callers in `activeLocationTask`, `driverStatusTransitions`.
- **Fix:** Call `resetPresenceHeartbeat()` whenever zone/classification/status changes (inside `enterStagingZone` and the transition functions), or make the throttle key-specific (`lastHeartbeatByZoneClass`). Force the heartbeat on any zone/classification change.
- **Testing:** Simulate A→B within 10 s → presence reflects B immediately.
- **Priority:** High · **Complexity:** Small

### LIFE-6 — Geofence exit clears presence only if a visit exists
- **Problem:** `handleExit` runs `processZoneExit` (the only place `clearPresenceSafe` fires) only inside `if (visitId && driverId)`. An active-task-staged driver has no `activeVisits` entry → no `visitId` → presence not cleared on exit (relies on next tick or 90 s TTL).
- **Why it matters:** Stale-count window after a real exit.
- **Where:** `src/lib/geofenceEngine.js` (`handleExit`).
- **Fix:** Always clear presence and set the correct next status (ACTIVE/EXIT_GRACE) on a confirmed exit; process the visit only if a `visitId` exists. Once CNT-1 guarantees a visit, this also closes naturally — but make presence-clear unconditional regardless.
- **Testing:** Stage via active task (no geofence visit), then exit → presence cleared immediately.
- **Priority:** High · **Complexity:** Medium

---

## Phase 2 — Server-side eligibility authority + PostGIS

Moves the "is this driver countable?" decision to the backend. Resolves SEC-3, SEC-4, SEC-5, CNT-4, GEO-2 (server side).

### SEC-3 — Backend trusts client-claimed zone/classification
- **Problem:** `upsert_driver_presence` checks ownership but writes whatever `zone_id`/`classification`/`lat`/`lng` the client sends.
- **Why it matters:** A modified/spoofed client can claim STAGING at any zone and be counted while the ping is fresh.
- **Where:** `supabase/migrations/011/012/014` (`upsert_driver_presence`); `src/lib/zoneStatsEngine.js`.
- **Fix:** Enable PostGIS; store zone polygons as `geometry` (backfill from `drawn_polygon`/`driven_polygon`); add a spatial index. Add `upsert_driver_presence_validated()` that recomputes the true zone via `ST_Contains`, enforces the per-zone accuracy ceiling, and only stamps `classification='STAGING'` when the point is genuinely inside an active/visible zone polygon — otherwise `ACTIVE`/`UNKNOWN`. Create an `eligible_driver_presence` view requiring: `tracking_enabled`, status `staged`, fresh `last_ping_at`, accuracy ≤ ceiling, account active, polygon containment, and (CNT-4) `active_visit_id IS NOT NULL`. Repoint `get_zone_live_stats.cars_staged` to read from it.
- **Steps:** (1) Migration: `CREATE EXTENSION IF NOT EXISTS postgis`; add `staging_zones.geom geometry(Polygon,4326)`; backfill; `CREATE INDEX … USING GIST(geom)`. (2) New validated RPC. (3) New `eligible_driver_presence` view. (4) Repoint counts. (5) JS calls the validated RPC (keep old as fallback).
- **Testing:** Send STAGING with coordinates outside the polygon → not counted. Inside → counted.
- **Priority:** Critical · **Complexity:** Large

### SEC-4 — No GPS-accuracy gate
- **Problem:** `accuracy` is stored but never gates counting (client or SQL).
- **Why it matters:** A 300–500 m fix counts the same as a 10 m fix; LV zones are tiny and adjacent to garages/valet/rideshare.
- **Where:** `presenceHeartbeat.js`; `eligible_driver_presence`; `staging_zones`.
- **Fix:** Add `MAX_PRESENCE_ACCURACY_METERS` (default 50) in `constants.js`; client drops/flags worse fixes; add per-zone `max_accuracy_meters` (GEO bundle) enforced in the view.
- **Testing:** Heartbeat with accuracy=200 → not counted; accuracy=20 → counted.
- **Priority:** High · **Complexity:** Medium

### SEC-5 — No mock-location / impossible-movement detection
- **Problem:** No anti-spoof signals.
- **Why it matters:** Spoofed GPS can fake staging.
- **Where:** `locationEngine.js`, `presenceHeartbeat.js`; optional audit flags table.
- **Fix:** On Android reject `location.mocked === true`; client-side sanity (speed/jump impossibility) → flag; optional `presence_anomaly_flags` for repeated suspicious staging.
- **Testing:** Inject mocked fix → blocked/flagged.
- **Priority:** High · **Complexity:** Medium

---

## Phase 3 — Geofence & background reliability

Resolves GEO-1, GEO-3, GEO-4, GEO-5, GEO-6, LIFE-10, RT-4.

### GEO-1 — Geofence task not registered for headless launch
- **Problem:** `App.jsx` imports only `passiveLocationTask`/`activeLocationTask` at module scope; `GEOFENCE_TASK` is defined only when `geofenceEngine.js` is imported via `HomeScreen`. On a headless background relaunch the geofence Enter/Exit may not be registered.
- **Why it matters:** The visit-creating geofence path is foreground-biased — the root cause behind CNT-1's real-world impact.
- **Where:** `App.jsx`; `src/lib/geofenceEngine.js`.
- **Fix:** Add `import './src/lib/geofenceEngine';` at top-level module scope in `App.jsx` (alongside the other two task imports) so `defineTask(GEOFENCE_TASK)` runs on every launch including headless.
- **Testing:** Cold-launch into background via a simulated geofence event → Enter handler fires; visit row created.
- **Priority:** Critical · **Complexity:** Small

### GEO-3 — 20-geofence cap uses UI sort, not nearest
- **Problem:** `getTop20Zones` slices by the active UI sort (FLOW/WAIT), so the monitored set may exclude nearby zones.
- **Why it matters:** Native Enter/Exit never fires for an un-monitored nearby zone → inconsistent visit creation.
- **Where:** `src/lib/geofenceEngine.js`.
- **Fix:** Decouple: geofence monitoring set = nearest 20 physical zones (always); UI list keeps its own sort.
- **Testing:** Set sort=WAIT, drive into the nearest zone → Enter fires.
- **Priority:** High · **Complexity:** Medium

### GEO-4 — Geofence recompute watches stats keys, not values
- **Problem:** Recompute trigger compares `Object.keys(stats)`, so FLOW/WAIT value changes don't refresh the monitored set.
- **Why it matters:** Monitored set goes stale if selection depends on those values (mitigated once GEO-3 makes selection nearest-based, but still fix the trigger).
- **Where:** `geofenceEngine.startGeofenceManager`.
- **Fix:** After GEO-3, monitored set depends only on position; drop the stats-key trigger for geofencing (keep position/zone-set triggers). If any stat dependence remains, hash relevant values with debounce.
- **Testing:** Change a zone's wait value → no unnecessary geofence churn; move 0.5 mi → recompute fires.
- **Priority:** Medium · **Complexity:** Small

### GEO-5 — Inconsistent polygon-error safety
- **Problem:** `geofenceEngine.verifyWithPolygon` returns `true` on error (fail-open); `workAreaGeometry.pointInPolygon` returns `false` (fail-closed).
- **Why it matters:** Corrupt polygon data over-counts in one path, excludes in the other.
- **Where:** `geofenceEngine.js`, `workAreaGeometry.js`.
- **Fix:** Standardize fail-closed for *confirmed staging*: polygon error → at most `UNKNOWN`, never counted as STAGING.
- **Testing:** Feed a malformed polygon → driver not counted as staged.
- **Priority:** Medium · **Complexity:** Small

### GEO-2 — Polygon-less zones counted by radius
- **Problem:** No-polygon zones counted via 80 m native circle, 200 m center fallback (`workAreaGeometry`/`tierManager`), and the manual button's 200 m. Zone radii are 40–80 m.
- **Why it matters:** Drop-offs / passing traffic / adjacent property count as staged.
- **Where:** `geofenceEngine.verifyWithPolygon`, `workAreaGeometry.detectStagingZoneFromPoint`, `tierManager.detectStagingZone`, `ImStagingButton`.
- **Fix:** A zone may yield *confirmed STAGING* only if it has a polygon and the point is inside it. Polygon-less zones → `UNKNOWN`/"nearby" + an admin "needs polygon" flag. (Enforced centrally once Phase 1/2 route through `enterStagingZone` + the validated RPC.)
- **Testing:** Polygon-less zone, driver within 150 m → not counted as STAGING; shown as nearby.
- **Priority:** High · **Complexity:** Medium

### GEO-6 — Active task stages outside the work area
- **Problem:** Staging-zone detection overrides work-area containment (`staging_zone_overrode_work_area_outside`).
- **Why it matters:** Possibly intentional (airport pit polygons outside the work area), but undocumented.
- **Where:** `activeLocationTask.js`, `passiveLocationTask.js`.
- **Fix:** Decide and document the rule. If staging requires inside-work-area, change to: `zone && !insideWorkArea → UNKNOWN/ignore + flag`. Otherwise add a code comment + admin guarantee that all staging polygons are trusted.
- **Testing:** Place a staging polygon outside the work area; verify the chosen behavior.
- **Priority:** Low · **Complexity:** Small

### LIFE-10 — Background permission not verified
- **Problem:** Reconcile/start gate on foreground permission only, then start background `startLocationUpdatesAsync`.
- **Why it matters:** "While Using" grant looks tracked but silently stops heartbeating when backgrounded → vanishes from count after 90 s.
- **Where:** `backgroundTrackingService.js` (`hasPermissions`, `reconcileTrackingOnAppLaunch`); UI banner.
- **Fix:** Check `getBackgroundPermissionsAsync`; if not granted while a driver expects live staging, show a persistent degraded banner and don't claim background tracking.
- **Testing:** Grant foreground-only → app shows degraded warning; background heartbeats not assumed.
- **Priority:** High · **Complexity:** Small

### RT-4 — Force-close silent drop; no staleness UI
- **Problem:** After force-close, heartbeats stop; the driver believes they're staged until the 90 s TTL drops them.
- **Where:** `AutoStatusBar.jsx` / `ConnectionBanner.jsx`; `presenceFreshness.js`.
- **Fix:** Surface "Last heartbeat: Ns ago / Live tracking active" using `secondsSincePing`; warn past ~40 s.
- **Testing:** Kill the watcher → UI shows staleness within seconds.
- **Priority:** Medium · **Complexity:** Small

---

## Phase 4 — State-machine consolidation & lifecycle

Resolves LIFE-1, LIFE-3, LIFE-4, LIFE-5, LIFE-7, LIFE-8, LIFE-9, RT-5; adds the audit log.

### LIFE-1 — Two parallel state machines
- **Problem:** `tierManager.js` independently detects work-area/zone (own cache) and writes `gps_tier`, `work_area_entry_time`, `work_area_exit_time`, racing the background tasks on the same columns; it also runs a `setTimeout` exit grace that dies when backgrounded.
- **Why it matters:** Column clobbering, double polygon math (battery), and a redundant/unreliable grace path.
- **Where:** `tierManager.js`; `backgroundTracking/*`; `exitGraceManager.js`; `drivers` columns.
- **Fix:** Make the background tasks the single state authority. Reduce `tierManager` to GPS-cadence only (driven by the status the background tasks set) — it must not write status/zone/entry/exit columns or run its own grace. Route all status changes through one `transitionDriverState({from,to,zoneFrom,zoneTo,source,reason})` service (extend `driverStatusTransitions.js`).
- **Steps:** (1) Strip `tierManager`'s DB writes + exit timer; subscribe it to status to pick GPS mode. (2) Centralize transitions. (3) Emit one audit row per transition (LIFE-8).
- **Testing:** Drive a full cycle; verify only the background path writes `work_area_*` and exactly one audit row per change.
- **Priority:** High · **Complexity:** Large

### LIFE-8 — Device/session identity + transition audit log
- **Problem:** `driver_presence` PK is `driver_id`; two devices clobber one row. No transition history for debugging "why was I removed?"
- **Where:** `driver_presence`; new `driver_status_events`; clients pass device/session.
- **Fix:** Add `device_id`, `session_id`, `app_version`, `platform` to `driver_presence`; accept only the newest valid session. Add `driver_status_events(driver_id, previous_status, next_status, previous_zone_id, next_zone_id, lat, lng, accuracy, source, reason, created_at)` written by the transition service.
- **Testing:** Two simulated devices → only the active session counts; each transition logs one row.
- **Priority:** Medium · **Complexity:** Medium

### LIFE-3 — `SIGNED_OUT` doesn't clear presence/stop tasks
- **Problem:** The `signOut()` helper cleans up, but the `SIGNED_OUT` auth-event branch only clears Redux; token-expiry logout leaves the driver counted up to the TTL.
- **Where:** `sessionManager.js` (`onAuthStateChange`).
- **Fix:** Have the `SIGNED_OUT` branch call the same cleanup (`clearDriverPresence` + `stopAllBackgroundTracking` + `stopGeofenceManager`).
- **Testing:** Force a token expiry → presence cleared, tasks stopped.
- **Priority:** Medium · **Complexity:** Small

### LIFE-4 — Profile-fetch failure strands logged-in driver
- **Problem:** `Root` shows `MainTabs` only if `session && profile`; `fetchAndSetProfile` swallows errors and never retries → a network blip bounces a valid session to the login screen.
- **Where:** `sessionManager.js`, `App.jsx`.
- **Fix:** Retry profile fetch with backoff; render a "reconnecting" state instead of `AuthStack` when a session exists but the profile hasn't loaded.
- **Testing:** Simulate a failing profile fetch on launch → app retries, doesn't show login.
- **Priority:** High · **Complexity:** Small

### LIFE-5 — Reconcile re-runs on every token refresh
- **Problem:** `App.jsx` effect deps `[session, profile]`; `TOKEN_REFRESHED` swaps the session object hourly → repeated reconcile/start calls.
- **Where:** `App.jsx`.
- **Fix:** Gate the effect on `session?.user?.id` (stable) + a `profileLoaded` boolean rather than object identity.
- **Testing:** Trigger a token refresh → no task restart / reconcile thrash.
- **Priority:** Medium · **Complexity:** Small

### LIFE-7 — Exit-grace doesn't close an open visit
- **Problem:** `startExitGrace` clears zone/presence but leaves any open `zone_visits` row dangling.
- **Where:** `exitGraceManager.js`.
- **Fix:** On EXIT_GRACE entry, close any open visit (process classification) before clearing.
- **Testing:** Stage (with open visit) → leave work area → visit closed with dwell.
- **Priority:** Medium · **Complexity:** Small

### LIFE-9 — Orphan reconciliation can close an in-progress visit
- **Problem:** `closeOrphanedVisits` marks all open visits ABANDONED on launch; if the driver is still physically in the zone, their live visit is closed and the background task won't reopen one.
- **Where:** `visitReconciler.js`; `reconcileTrackingOnAppLaunch`.
- **Fix:** Before abandoning, re-check current GPS/polygon; if still inside, keep the visit open (or reopen via `enterStagingZone`).
- **Testing:** Relaunch while inside a zone with an open visit → visit preserved.
- **Priority:** Medium · **Complexity:** Medium

### RT-5 — Dead queue-position feature
- **Problem:** `getDriverPositionInZone` always returns null but is wired through `HomeScreen → ZoneListItem`.
- **Where:** `zoneStatsEngine.js`, `HomeScreen.jsx`, `ZoneListItem.jsx`.
- **Fix:** Either implement live ordering from `eligible_driver_presence` ordered by `entered_at`, or remove the dead UI path until implemented.
- **Testing:** Position shows a real rank, or the line is absent.
- **Priority:** Low · **Complexity:** Small

---

## Phase 5 — Realtime & scalability

Resolves RT-1, RT-2, RT-3, CNT-7, SCALE-1, OPS-1.

### SCALE-1 + RT-1 — Snapshot table + presence realtime
- **Problem:** Every client polls the heavy `get_zone_live_stats` every 30 s; realtime listens to `zone_stats` (no longer written by the live path), so counts ride on the poll + TTL.
- **Why it matters:** N clients × heavy recompute/30 s; counts feel laggy.
- **Where:** `useZones.js`; `get_zone_live_stats`; realtime publication; new `zone_live_stats_snapshot`.
- **Fix:** One backend job (pg_cron, ~10 s) refreshes a `zone_live_stats_snapshot` table; add it to the realtime publication; clients read the cheap snapshot + subscribe to its changes. Remove the per-client recompute on every realtime event.
- **Steps:** (1) Migration: snapshot table + a `refresh_zone_live_stats_snapshot()` that runs the existing CTE and upserts; schedule via pg_cron (fallback: Supabase Scheduled Function). (2) `alter publication supabase_realtime add table zone_live_stats_snapshot`. (3) `useZones` reads snapshot + subscribes; keep RPC as fallback.
- **Testing:** Simulate 100 clients → DB load is one refresh/10 s, not 100 polls/30 s; counts update within ~10 s of a presence change.
- **Priority:** High · **Complexity:** Medium

### CNT-7 — Realtime overwrites live count with stale legacy value
- **Problem:** A `zone_stats` realtime event carries legacy `cars_staged` (~0); `updateZoneStat` doesn't `preserve()` it, so the count flickers down until the next RPC.
- **Where:** `zonesSlice.updateZoneStat`, `useZones.js`.
- **Fix:** Resolved by RT-1 (read the snapshot, not `zone_stats`). Interim: add `cars_staged`/`nearby_unconfirmed` to the `preserve()` list so a leaner event can't blank a good value.
- **Testing:** Fire a legacy `zone_stats` event → displayed count doesn't dip.
- **Priority:** Medium · **Complexity:** Small

### RT-2 — Legacy fallback shows stale count silently
- **Problem:** When the live RPC fails, `useZones.load` falls back to `zone_stats` (stale) with no warning.
- **Where:** `useZones.js`, `ConnectionBanner.jsx`.
- **Fix:** Mark fallback data degraded; show "Showing cached stats — last updated …".
- **Testing:** Force RPC failure → degraded banner appears.
- **Priority:** Medium · **Complexity:** Small

### RT-3 — `mergeLiveStats` doesn't prune missing zones
- **Problem:** Only updates returned rows; a now-omitted zone keeps stale values.
- **Where:** `useZones.mergeLiveStats`.
- **Fix:** On a full snapshot load, replace the stats map; on incremental, merge.
- **Testing:** Remove a zone from RPC output → its stale stat clears.
- **Priority:** Low · **Complexity:** Small

### OPS-1 — Server-side stale-presence cleanup backstop
- **Problem:** Stale presence is removed only by view-time TTL filtering; rows linger physically.
- **Where:** new migration; pg_cron (pattern already used in 002/006).
- **Fix:** `clear_stale_presence()` that nulls zone/sets ACTIVE for rows older than the TTL; schedule via pg_cron (guarded fallback like 006).
- **Testing:** Insert an old presence row → job clears it; not counted.
- **Priority:** Medium · **Complexity:** Small

---

## Phase 6 — Data hygiene & docs

### DATA-1 — `zone_visits.classification` has no CHECK
- **Fix:** Add a CHECK allowing the known set (`staging`,`drop_off`,`passing`,`unknown`,`abandoned`) case-normalized; or normalize on write. **Priority:** Low · **Complexity:** Small
### DATA-2 — README setup wrong
- **Fix:** Update README to require migrations `001`–latest (not just `schema.sql`); note the `'browsing'` default is migrated away by `001`. **Priority:** Low · **Complexity:** Small
### DATA-3 — Dead `drivers.current_lat/current_lng`
- **Fix:** Mark deprecated in a comment; optionally drop in a later migration once confirmed unused. **Priority:** Low · **Complexity:** Small
### DATA-4 — Training-data confirmation not offline-queued
- **Fix:** Add a `SAVE_TRAINING_DATA` side-effect type to the offline queue in `visitProcessor.js`. **Priority:** Low · **Complexity:** Small

---

## Phase 7 — Testing & QA (woven through every phase)

### QA-1 — Test matrix
- **Unit (Jest):** `behavioralClassifier` thresholds; `presenceFreshness` TTL boundary; the new eligibility predicate; the shared polygon-confirmation helper; heartbeat throttle reset on zone change.
- **Integration:** each staging path yields exactly one open visit + presence with `active_visit_id`; UNKNOWN not in `cars_staged`; poor accuracy / mocked location not counted; exit clears presence regardless of visit; exit-grace closes open visits; orphan reconciliation preserves in-progress visits.
- **Geofence simulation:** Enter/Exit fire after a cold headless launch (GEO-1); nearest-20 monitored regardless of sort (GEO-3); polygon error fails closed (GEO-5).
- **Supabase query tests:** `get_zone_live_stats` count rule; `eligible_driver_presence` filters; snapshot refresh correctness; RLS — driver A cannot read B's presence (SEC-1); anon cannot call the RPC (SEC-2).
- **Real-device GPS:** drift near multi-level resorts; foreground↔background transitions; 90 s TTL drop/recover; force-close staleness UI.
- **Regression checklist (run before each merge):** auth/login still works; zone list renders & sorts; live count matches a known staged driver within 10 s; wait estimate populates from real dwell; logout clears presence; offline→online replay drains queues; no duplicate visits; battery sane (single GPS watcher).

---

# Part 2 — Claude Code Prompt (copy & paste)

> Paste everything below into Claude Code from the repo root. It references the issue IDs in Part 1.

---

You are working in the `senayabraha/LvTaxi` repository (React Native/Expo + Supabase/Postgres). You will implement a multi-phase fix plan. Work carefully and incrementally. Do not break existing working features.

**STEP 0 — Review before editing.** Before changing anything, read and summarize back to me: `App.jsx`; `src/lib/constants.js`, `driverStatusTransitions.js`, `geofenceEngine.js`, `locationEngine.js`, `presenceHeartbeat.js`, `zoneStatsEngine.js`, `workAreaGeometry.js`, `tierManager.js`, `sessionManager.js`, `visitProcessor.js`, `visitReconciler.js`; `src/lib/backgroundTracking/*`; `src/hooks/useZones.js`; `src/store/*`; `src/components/ImStagingButton.jsx`, `ZoneListItem.jsx`, `AutoStatusBar.jsx`, `ConnectionBanner.jsx`; `src/screens/HomeScreen.jsx`; and `supabase/migrations/011,012,014,018` plus `supabase/schema.sql`. Do not trust the README or code comments for current behavior — verify in code. Then output a short PLAN (files to touch, new migration numbers, new tests) and WAIT for my approval before coding.

**HARD CONSTRAINTS.**
1. Migrations are append-only: add new numbered files (`019_…`, `020_…`, …) using `CREATE OR REPLACE`, `IF NOT EXISTS`, additive `ALTER`. Never edit `001`–`018` or `schema.sql`.
2. Backward compatible: keep existing JS function signatures; the app must run if a new migration isn't applied yet (mirror the `isMissingFunctionError` fallback in `visitProcessor.js`).
3. Define every new tunable once in `src/lib/constants.js` and document the matching SQL value beside it.
4. Preserve existing RLS ownership checks, `SECURITY DEFINER` + `auth.uid()` guards, and the offline-replay design.
5. One logical fix per commit, message referencing the issue ID.

**IMPLEMENT IN THIS ORDER. After each phase, stop and show me the diff before continuing.**

- **Phase 0 (Security hotfix):** SEC-1 (drop `all_read_presence`, add own-row + admin read), SEC-2 (revoke `anon` from `get_zone_live_stats`), LIFE-11 (`clear_driver_presence` sets `last_ping_at=now()`). One migration `019`.
- **Phase 1 (Counting core):** Create `src/lib/stagingService.js` with `enterStagingZone(...)` that ensures exactly one open `zone_visits` row (new `ensure_open_visit` RPC + unique partial index `one_open_visit_per_driver`), starts trajectory recording, writes `drivers` + presence (with `active_visit_id`), and resets the heartbeat throttle. Route `geofenceEngine.completeHandleEnter`, `ImStagingButton.stageAt`, and the staging branches of `activeLocationTask`/`passiveLocationTask` through it (CNT-1, CNT-2, CNT-4, CNT-5, LIFE-2). Make geofence exit clear presence unconditionally (LIFE-6). Split the live count so `cars_staged` counts only `STAGING` and add `nearby_unconfirmed` for `UNKNOWN` (CNT-3); update the RPC return shape, `ZoneStat` type, and `ZoneListItem`. Add `zone_departures.visit_id` unique to stop double-counting (CNT-6).
- **Phase 2 (Server authority):** Enable PostGIS; add `staging_zones.geom` (backfill from polygons) + GIST index; add `upsert_driver_presence_validated()` (recompute zone via `ST_Contains`, enforce accuracy ceiling) and an `eligible_driver_presence` view; repoint counts to it (SEC-3, SEC-4, GEO-2 server side, CNT-4). Add per-zone `max_accuracy_meters`, `requires_polygon_confirmation`, `min_dwell_seconds_before_count`, `stale_after_seconds`. Client: reject Android `mocked` fixes and accuracy worse than `MAX_PRESENCE_ACCURACY_METERS` (default 50) before staging (SEC-5, SEC-4 client).
- **Phase 3 (Geofence/background reliability):** Import `geofenceEngine` at top-level in `App.jsx` so `GEOFENCE_TASK` registers on headless launch (GEO-1). Monitor the nearest 20 zones regardless of UI sort (GEO-3); fix the recompute trigger (GEO-4); make polygon errors fail closed for confirmed staging (GEO-5); decide+document the outside-work-area staging rule (GEO-6); verify background permission and show a degraded banner when missing (LIFE-10); add last-heartbeat staleness UI (RT-4).
- **Phase 4 (State machine & lifecycle):** Reduce `tierManager` to GPS-cadence only and stop it writing status/zone/entry/exit columns or running its own grace timer; route all transitions through one `transitionDriverState(...)` (LIFE-1). Add `device_id/session_id/app_version/platform` to presence and a `driver_status_events` audit table (LIFE-8). Make the `SIGNED_OUT` auth branch run full cleanup (LIFE-3). Retry profile fetch and don't bounce a valid session to login (LIFE-4). Gate the launch effect on a stable user id (LIFE-5). Close open visits on exit-grace (LIFE-7). Preserve in-progress visits in orphan reconciliation (LIFE-9). Fix or remove the dead queue-position UI (RT-5).
- **Phase 5 (Realtime & scale):** Add `zone_live_stats_snapshot` + a pg_cron refresh (guarded fallback) and add it to the realtime publication; `useZones` reads the snapshot and subscribes to it (SCALE-1, RT-1). Add `cars_staged`/`nearby_unconfirmed` to `updateZoneStat`'s `preserve()` (CNT-7). Show a degraded banner on legacy fallback (RT-2). Replace the full stats map on full loads (RT-3). Add `clear_stale_presence()` on a schedule (OPS-1).
- **Phase 6 (Hygiene):** `zone_visits.classification` CHECK/normalize (DATA-1); fix README setup (DATA-2); deprecate dead `current_lat/lng` columns (DATA-3); offline-queue training-data confirmation (DATA-4).

**TESTING.** Add/extend Jest unit tests and SQL/integration tests per the QA matrix: each staging path → one open visit + presence with `active_visit_id`; UNKNOWN excluded from `cars_staged`; poor-accuracy/mocked fixes not counted; exit clears presence regardless of visit; RLS denies cross-driver presence reads; geofence Enter fires after cold headless launch; nearest-20 monitored regardless of sort. Run the regression checklist before declaring each phase done.

**STYLE.** Add comments only where logic is non-obvious (e.g., the eligibility predicate, the dual-path consolidation). Do not over-comment simple code.

**AFTER EACH PHASE:** explain every change you made and why, list changed files and new migrations, give exact testing steps, and call out any remaining risks or assumptions.

**FINAL DELIVERABLE:** a summary of all changed files, all database changes (tables/columns/indexes/policies/functions/cron), the full testing procedure, and a remaining-risk register (including anything you couldn't safely verify, such as real-device background behavior and PostGIS availability on the target Supabase plan).
