# LV Taxi — System Risk Register

> Analysis-only. All risks found during the audit. Status = Open for all.

---

### R-01
- **Title:** Fail-closed work-area gate misclassifies in-zone driver as passive
- **Severity:** Critical
- **Subsystem:** Work-area geometry / state machine
- **Description:** If the active `work_areas` polygon fails to load (empty table, cache miss on
  fresh install, malformed polygon), `isInsideWorkAreaPolygon` returns false and the driver is kept
  `passive_far`/`passive_near` even when physically inside a staging zone. Passive blocks the
  heartbeat, so the driver is never counted.
- **Evidence:** `workAreaGeometry.js` (inside test), `passiveLocationTask.js:70-120`,
  `presenceHeartbeat.js:46`. Matches the Samsung Terminal 1 symptoms.
- **Files:** `src/lib/workAreaGeometry.js`, `src/lib/backgroundTracking/passiveLocationTask.js`,
  `src/lib/backgroundTracking/backgroundTrackingService.js`.
- **DB objects:** `work_areas`.
- **Reproduce:** Remove/disable active work area (or block its fetch), drive into T1, observe passive.
- **Impact:** Drivers physically staging show 0 cars; counts globally undercount.
- **Recommended fix:** Make work-area load failure explicit (telemetry + UI), and fall back safely
  (e.g. trust staging-zone polygon for `staged` when work area is unavailable, or block tracking with
  a clear error rather than silently passive).
- **Priority:** P0 · **Owner:** TBD · **Status:** Open

### R-02
- **Title:** No central status state machine (uncoordinated writers)
- **Severity:** High
- **Subsystem:** Driver status
- **Description:** `drivers.status` is written from ≥11 sites (UI, geofence, passive/active tasks,
  exit grace, reconcile). Last-writer-wins can flip a `staged` driver back to passive without
  clearing `currentZoneId`.
- **Evidence:** see `driver-status-state-machine.md` §1 write-site table.
- **Files:** geofenceEngine.js, passiveLocationTask.js, activeLocationTask.js, exitGraceManager.js,
  backgroundTrackingService.js, DriverToggle.jsx, ImStagingButton.jsx.
- **DB objects:** `drivers.status`.
- **Reproduce:** Concurrent geofence enter + passive reconcile during a fix.
- **Impact:** Status/zone/count contradictions; the Terminal 1 bug class.
- **Recommended fix:** Centralize transitions in one reducer/service; make `currentZoneId` derive
  from status, clearing it whenever status leaves active/staged.
- **Priority:** P0 · **Owner:** TBD · **Status:** Open

### R-03
- **Title:** Heartbeat guard discards forced writes while passive
- **Severity:** High
- **Subsystem:** Presence heartbeat
- **Description:** `isHeartbeatStatus` check runs before the `force` check, so `force:true` writes are
  dropped if status hasn't been promoted yet — couples count correctness to write ordering.
- **Evidence:** `presenceHeartbeat.js:46` (guard) precedes `:49` (force).
- **Files:** `src/lib/presenceHeartbeat.js`.
- **DB objects:** `driver_presence`.
- **Reproduce:** Call forced heartbeat before status promotion.
- **Impact:** Silent no-count even when the code "forces" a write.
- **Recommended fix:** Allow forced writes when an explicit STAGING/UNKNOWN classification + zone is
  passed, or guarantee status promotion is awaited before forcing.
- **Priority:** P0 · **Owner:** TBD · **Status:** Open

### R-04
- **Title:** Samsung/Android battery optimization can stop background tasks
- **Severity:** High
- **Subsystem:** Background tracking
- **Description:** No battery-optimization exemption is requested. Samsung "Sleeping apps"/Deep Sleep
  can kill the foreground-service tasks, so promotion + heartbeat never run.
- **Evidence:** `app.config.js:74-81` (no `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), Samsung field bug.
- **Files:** `app.config.js`, `backgroundTrackingService.js`.
- **Reproduce:** Default Samsung battery settings, background app at a zone.
- **Impact:** Intermittent undercount; driver appears offline while working.
- **Recommended fix:** Request battery-optimization exemption + onboarding guidance to set the app
  "Unrestricted"; surface a warning when throttled.
- **Priority:** P0 · **Owner:** TBD · **Status:** Open

### R-05
- **Title:** `currentZoneId` not cleared when status drops to passive
- **Severity:** High
- **Subsystem:** Redux / UI
- **Description:** `setStatus(passive_*)` does not clear `currentZoneId`, so "You are here" persists
  with a 0 count.
- **Evidence:** `driversSlice.js:59-70` vs `:100-117`.
- **Files:** `src/store/driversSlice.js`, `src/components/ZoneListItem.jsx`, `HomeScreen.jsx`.
- **Impact:** UI contradiction; misleads drivers.
- **Recommended fix:** Clear zone on passive/exit_grace/disabled, or derive "You are here" from
  presence agreement.
- **Priority:** P0 · **Owner:** TBD · **Status:** Open

### R-06
- **Title:** `driver_presence` readable by all authenticated users (location privacy)
- **Severity:** High
- **Subsystem:** RLS / privacy
- **Description:** `all_read_presence` grants SELECT to everyone; exposes every driver's live
  lat/lng/speed/zone.
- **Evidence:** `011_presence_based_zone_stats.sql:55-64`.
- **DB objects:** `driver_presence` RLS.
- **Impact:** Privacy/regulatory exposure of precise driver locations.
- **Recommended fix:** Restrict reads to admins/service; expose only aggregate counts to drivers.
- **Priority:** P1 · **Owner:** TBD · **Status:** Open

### R-07
- **Title:** Soft-deleted driver can still UPDATE own row
- **Severity:** Medium
- **Subsystem:** RLS / lifecycle
- **Description:** `deleted_at is null` is only in the USING clause, not WITH CHECK.
- **Evidence:** `006_account_lifecycle.sql:20-23`.
- **Impact:** Deleted account could resurrect data.
- **Recommended fix:** Apply deleted_at check to WITH CHECK / split policies.
- **Priority:** P1 · **Owner:** TBD · **Status:** Open

### R-08
- **Title:** Wait/flow depends on client-written `zone_departures`/`dwell_seconds` (no DB trigger)
- **Severity:** Medium
- **Subsystem:** Wait-time algorithm
- **Description:** If the client fails to log departures or dwell, service rate is 0 and waits are
  unavailable.
- **Evidence:** `geofenceEngine handleExit` writes dwell; departures logged client-side; no triggers.
- **DB objects:** `zone_departures`, `zone_visits`.
- **Impact:** Persistent INSUFFICIENT_DATA / NO_RECENT_MOVEMENT.
- **Recommended fix:** Verify departure writes; consider DB-side derivation.
- **Priority:** P1 · **Owner:** TBD · **Status:** Open

### R-09
- **Title:** No test-zone name filter; possible test zones active in production
- **Severity:** Medium
- **Subsystem:** Zones / admin
- **Description:** `zoneHealth.js` keys only on `active`/`is_coming_soon`. Test-named active zones
  would register geofences and pollute counts.
- **Evidence:** `admin/src/lib/zoneHealth.js`; no name check.
- **DB objects:** `staging_zones`.
- **Impact:** Polluted counts/geofence slots.
- **Recommended fix:** Admin check + DB audit for test-looking names; require coming-soon ⇒ inactive.
- **Priority:** P1 · **Owner:** TBD · **Status:** Open

### R-10
- **Title:** Legacy `DriverToggle` (off_duty/active) conflicts with automatic machine
- **Severity:** Medium
- **Subsystem:** UI / status
- **Description:** Manual toggle can force `off_duty`/`active` against GPS-driven transitions.
- **Evidence:** `DriverToggle.jsx:52`.
- **Impact:** Stray off_duty silently stops counting.
- **Recommended fix:** Remove/disable or gate behind debug.
- **Priority:** P2 · **Owner:** TBD · **Status:** Open

### R-11
- **Title:** Three inconsistent staleness windows (90 s / 5 min / 30 min)
- **Severity:** Medium
- **Subsystem:** UI / admin consistency
- **Description:** Different freshness thresholds across mobile and admin invite contradictory states.
- **Evidence:** `constants.js:148`, `DriversPage.jsx:8`, `zoneHealth.js:11`.
- **Recommended fix:** Single TTL source + derived labels.
- **Priority:** P2 · **Owner:** TBD · **Status:** Open

### R-12
- **Title:** schema.sql default `browsing` invalid vs CHECK
- **Severity:** Medium
- **Subsystem:** DB schema
- **Description:** Standalone schema.sql apply yields an invalid default until migration 001.
- **Evidence:** `schema.sql:11`, `001:16-22`.
- **Recommended fix:** Align default to `tracking_disabled` (doc-only here).
- **Priority:** P2 · **Owner:** TBD · **Status:** Open

### R-13
- **Title:** Geofence registers only top-20 zones (scaling cliff)
- **Severity:** Low
- **Subsystem:** Geofence
- **Description:** Zones outside the top-20 by current sort get no geofence.
- **Evidence:** `geofenceEngine.getTop20Zones`/`applyGeofences`.
- **Impact:** Future undercount when zone count grows.
- **Recommended fix:** Prioritize by proximity; document the limit.
- **Priority:** P3 · **Owner:** TBD · **Status:** Open

### R-14
- **Title:** "Data stale" copy conflates client-refresh gap with insufficient data
- **Severity:** Low
- **Subsystem:** UI
- **Description:** RPC always sets `last_updated=now()`; "Data stale" actually means the client poll/
  realtime didn't refresh.
- **Evidence:** `012_...:206`, `ZoneListItem.jsx:94-102`, `useZones.js`.
- **Recommended fix:** Separate messaging; show last successful fetch time.
- **Priority:** P3 · **Owner:** TBD · **Status:** Open

### R-15
- **Title:** Insufficient debug visibility for field diagnosis
- **Severity:** Low
- **Subsystem:** Debug/QA
- **Description:** No surfaced work-area-loaded flag, last-task-run, heartbeat result, or Redux-vs-DB
  zone divergence — made the Samsung bug hard to diagnose.
- **Evidence:** `TrackingDebugPanel.jsx`, `trackingDebug.js`.
- **Recommended fix:** Add debug fields per `gps-background-tracking-analysis.md` §7.
- **Priority:** P1 · **Owner:** TBD · **Status:** Open

### R-16
- **Title:** EXIT_GRACE classification whitelist depends on migration order
- **Severity:** Low
- **Subsystem:** DB / presence
- **Description:** `upsert_driver_presence` in 012 omits EXIT_GRACE; added in 014. Out-of-order apply
  normalizes EXIT_GRACE→ACTIVE.
- **Evidence:** `012_...:46`, `014`.
- **Recommended fix:** Confirm migration order; design clears presence in grace anyway.
- **Priority:** P3 · **Owner:** TBD · **Status:** Open

### R-17
- **Title:** Excessive/insufficient Supabase write tuning is fragile
- **Severity:** Low
- **Subsystem:** Write policy
- **Description:** 25 s heartbeat vs 90 s TTL is sound now, but tightly coupled; lowering heartbeat
  (future Redis path) without revisiting TTL would create gaps or write storms.
- **Evidence:** `constants.js:109-159`, `locationWritePolicy.js`.
- **Recommended fix:** Document invariants (heartbeat << TTL); guard against misconfiguration.
- **Priority:** P3 · **Owner:** TBD · **Status:** Open
