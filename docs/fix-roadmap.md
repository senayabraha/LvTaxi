# LV Taxi Fix Roadmap

Analysis-only planning document. Do not implement these fixes until the implementation phase is explicitly approved.

## P0 — Critical correctness

### P0-001 — Centralize driver status transitions

**Problem:** Status transitions are spread across background tasks, geofenceEngine, ImStagingButton, DriverToggle, and reducers.

**Affected files:** `driversSlice.js`, `backgroundTrackingService.js`, `passiveLocationTask.js`, `activeLocationTask.js`, `exitGraceManager.js`, `geofenceEngine.js`, `ImStagingButton.jsx`, `DriverToggle.jsx`.

**Recommended change:** Create a single driver state-machine service that owns transitions into passive, active, staged, exit_grace, and tracking_disabled. All modules call this service instead of directly setting status/zone/presence.

**Risk:** Touches critical flow; must be tested on real devices.

**Test plan:** Unit transition tests + Samsung Terminal 1 foreground/background regression + Supabase SQL verification.

**Estimated difficulty:** High.

**Dependencies:** Status contract finalized.

---

### P0-002 — Make staged transition atomic

**Problem:** A driver can have `currentZoneId` set without a fresh countable presence row.

**Affected files:** state-machine service, `presenceHeartbeat.js`, `zoneStatsEngine.js`, `geofenceEngine.js`, `activeLocationTask.js`, `ImStagingButton.jsx`.

**Recommended change:** Implement `enterStaged(zoneId, gps, reason)` that updates Redux, `drivers.status/current_zone_id`, and `driver_presence` in a defined order with error reporting. If presence write fails, UI should show not-counted state.

**Risk:** Partial failures need clear rollback/visibility.

**Test plan:** Force RPC failure; confirm UI says not counted and admin shows mismatch.

**Estimated difficulty:** High.

**Dependencies:** P0-001.

---

### P0-003 — Fix “You are here” semantics

**Problem:** UI says “You are here” based only on Redux `currentZoneId`.

**Affected files:** `HomeScreen.jsx`, `ZoneListItem.jsx`, maybe `useZones.js`.

**Recommended change:** Split labels into:

- GPS/current-zone detected.
- Staged and counted.
- Detected but not counted.

Require status/presence agreement for counted state.

**Risk:** Requires access to current driver presence or local heartbeat state.

**Test plan:** Simulate passive + currentZoneId; UI must not imply queue count.

**Estimated difficulty:** Medium.

**Dependencies:** Debug/presence selector.

---

### P0-004 — Validate active work-area coverage

**Problem:** Missing/invalid work-area polygons keep drivers passive everywhere.

**Affected files:** admin SystemCheck, `workAreaGeometry.js`, docs/SQL tooling.

**Recommended change:** Add admin health check: at least one active work area exists; Terminal 1/T3 zones are inside an active work area; mobile debug panel shows work-area polygon count and inside result.

**Risk:** Requires geometry validation utilities.

**Test plan:** Disable work area in staging DB; debug/admin must flag immediately.

**Estimated difficulty:** Medium.

**Dependencies:** Access to production/staging zone data.

---

### P0-005 — Samsung Terminal 1 regression fix/verification

**Problem:** Real test showed passive status while physically staged.

**Affected files:** depends on root cause; likely background tracking, geometry, UI, presence.

**Recommended change:** Execute real-device QA after P0-001 through P0-004; fix whichever root cause is confirmed.

**Risk:** Device-specific behavior may require app config changes.

**Test plan:** Follow `docs/real-device-qa-plan.md` GPS-004 through GPS-006.

**Estimated difficulty:** Medium to High.

**Dependencies:** Samsung device, Supabase access, debug panel.

---

### P0-006 — Disable or remove legacy `DriverToggle`

**Problem:** It writes legacy `off_duty` and manual `active`, conflicting with automatic tracking.

**Affected files:** `DriverToggle.jsx`, any screen importing it, admin filters/docs.

**Recommended change:** Remove from production UI or replace with a tracking-enabled control that calls the central state machine/reconciliation.

**Risk:** If still used by a screen, UX may change.

**Test plan:** Search imports; verify no manual `off_duty` writes in app flow.

**Estimated difficulty:** Low to Medium.

**Dependencies:** Decide product UX for enabling/disabling tracking.

## P1 — Reliability and diagnostics

### P1-001 — Expand TrackingDebugPanel

**Problem:** Field testers cannot diagnose status/presence/count mismatch.

**Affected files:** `TrackingDebugPanel.jsx`, `trackingDebug.js`, heartbeat/background services.

**Recommended change:** Show GPS, task status, work-area result, detected zone, last heartbeat attempt/success/error, presence age, last RPC result, permission, battery optimization guidance.

**Risk:** Avoid exposing precise GPS in screenshots/logs unintentionally.

**Test plan:** Run Terminal 1 test and identify exact failure stage from panel alone.

**Estimated difficulty:** Medium.

**Dependencies:** Debug state plumbing.

---

### P1-002 — Add admin count-eligibility diagnostics

**Problem:** Admin currently shows status/presence but does not explicitly identify count eligibility or mismatches.

**Affected files:** `admin/src/pages/DriversPage.jsx`, `admin/src/pages/SystemCheckPage.jsx`.

**Recommended change:** Add columns/cards for driver zone, presence zone, presence class, presence age, count eligible yes/no, mismatch reason.

**Risk:** More columns can clutter mobile admin layout.

**Test plan:** Create mismatched test rows; admin flags them.

**Estimated difficulty:** Medium.

**Dependencies:** None.

---

### P1-003 — SQL health checks for geometry and status/presence mismatch

**Problem:** Repeated manual SQL is error-prone.

**Affected files:** docs/admin scripts; possibly `admin/scripts`.

**Recommended change:** Add read-only SQL scripts or admin views for active work areas, invalid zones, test zones, status/presence mismatch, stale presence, and live-count path.

**Risk:** Must not expose sensitive location to unauthorized users.

**Test plan:** Run scripts in staging and production.

**Estimated difficulty:** Medium.

**Dependencies:** Supabase admin access.

---

### P1-004 — Improve background permission and battery UX

**Problem:** Samsung/Android background restrictions can silently break live counts.

**Affected files:** `LocationPermissionScreen.jsx`, app config, debug panel, docs.

**Recommended change:** Detect permission state and explain background/always permission; add Samsung battery optimization instructions.

**Risk:** Platform-specific UI complexity.

**Test plan:** Permission revoked/while-using/always matrix on Samsung and iPhone.

**Estimated difficulty:** Medium.

**Dependencies:** Confirm Expo config.

---

### P1-005 — Reconcile stale current zone and stale open visits

**Problem:** Stale `currentZoneId` and open `zone_visits` can show wrong zone/position.

**Affected files:** `visitReconciler.js`, `geofenceEngine.js`, `HomeScreen.jsx`, state-machine service.

**Recommended change:** Clear current zone on passive/disabled; reconcile open visits when presence is stale or exit is missed.

**Risk:** Could close legitimate long airport waits if thresholds are too aggressive.

**Test plan:** Create stale open visit; verify cleanup after threshold.

**Estimated difficulty:** Medium.

**Dependencies:** Per-zone dwell thresholds.

## P2 — Maintainability

### P2-001 — Generate current Supabase schema snapshot

**Problem:** `schema.sql` is stale against migrations.

**Affected files:** `supabase/schema.sql`, docs.

**Recommended change:** Generate schema from deployed database after migrations and clearly mark baseline vs snapshot.

**Risk:** Snapshot may include environment-specific objects; review carefully.

**Test plan:** Fresh local DB can migrate cleanly.

**Estimated difficulty:** Medium.

**Dependencies:** Supabase CLI/database access.

---

### P2-002 — Add state-machine unit tests

**Problem:** Status transitions can regress.

**Affected files:** new tests around state-machine service.

**Recommended change:** Test every transition in `driver-status-state-machine.md`.

**Risk:** Requires test harness/mocks for Supabase and location.

**Test plan:** CI unit tests.

**Estimated difficulty:** Medium.

**Dependencies:** P0-001.

---

### P2-003 — Consolidate geometry code

**Problem:** `tierManager` duplicates work-area/staging-zone geometry logic from `workAreaGeometry`.

**Affected files:** `tierManager.js`, `workAreaGeometry.js`.

**Recommended change:** Make `workAreaGeometry` the only polygon detection utility; tierManager consumes it.

**Risk:** GPS tier behavior can change.

**Test plan:** Unit geometry tests and field GPS smoke test.

**Estimated difficulty:** Medium.

**Dependencies:** State-machine stabilization.

---

### P2-004 — Separate live count confidence from wait confidence

**Problem:** UI can confuse count correctness with wait estimate confidence.

**Affected files:** `ZoneListItem.jsx`, `get_zone_live_stats()` if extra fields needed.

**Recommended change:** Show “Live count” freshness separately from “Wait estimate learning/confidence.”

**Risk:** More UI text.

**Test plan:** One-driver test shows count 1 and wait learning.

**Estimated difficulty:** Low to Medium.

**Dependencies:** UI design choice.

## P3 — Product polish

### P3-001 — Better driver-facing status explanations

**Problem:** Drivers may not understand passive/active/staged/exit grace.

**Affected files:** `AutoStatusBar.jsx`, help/modal components.

**Recommended change:** Add tap-to-explain status: what it means, whether counted, last heartbeat, next expected action.

**Risk:** UI clutter.

**Test plan:** Driver usability review.

**Estimated difficulty:** Low.

**Dependencies:** Stable status semantics.

---

### P3-002 — Admin alerts

**Problem:** Admin must proactively know when zones or counts are unhealthy.

**Affected files:** admin dashboard/system check.

**Recommended change:** Alerts for no active work area, stale all presence, active test zones, zones with missing polygons, high mismatch count.

**Risk:** False positives if thresholds are wrong.

**Test plan:** Seed known bad configs.

**Estimated difficulty:** Medium.

**Dependencies:** P1 SQL health checks.

---

### P3-003 — QA dashboard

**Problem:** Field testing currently depends on manual SQL and screenshots.

**Affected files:** admin QA page.

**Recommended change:** Add a test-driver live pipeline view: mobile status, DB status, presence, active view, stats RPC, last task, geometry result.

**Risk:** Sensitive location access must be restricted.

**Test plan:** Use during Terminal 1 regression test.

**Estimated difficulty:** Medium.

**Dependencies:** P1 diagnostics.

## Recommended execution order

1. P0-004: verify work-area and Terminal 1/T3 geometry immediately.
2. P1-001/P1-002: add diagnostics before changing complex logic.
3. P0-001/P0-002: centralize and atomically fix status/presence transitions.
4. P0-003: fix misleading current-zone UI.
5. P0-006: remove/replace legacy DriverToggle.
6. P0-005: run Samsung Terminal 1 regression.
7. P1 reliability and P2 maintainability work.

## Real-device test gate

Before shipping implementation fixes, pass:

- Samsung Terminal 1 foreground/background/locked.
- iPhone Terminal 1 foreground/background.
- Terminal 3 staging.
- One hotel staging zone.
- Leave staging inside work area.
- Leave work area into exit grace.
- Re-enter during grace.
- Offline/online recovery.
- Permission revoked.
