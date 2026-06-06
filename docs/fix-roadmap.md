# LV Taxi — Fix Roadmap

> Analysis-only. Staged plan; **no fixes implemented**. Each item maps to risks in
> `system-risk-register.md`. Difficulty: S (small) / M / L.

---

## P0 — Critical correctness

### F0-1 — Fix the status/zone/count divergence (work-area gate + writers)  *(R-01, R-02, R-05)*
- **Problem:** A driver physically in a staging zone can be `passive` with `currentZoneId` set and 0
  count (the Samsung Terminal 1 bug), because the work-area gate fails closed, writers are
  uncoordinated, and `currentZoneId` isn't cleared on passive.
- **Affected files:** `src/lib/workAreaGeometry.js`, `passiveLocationTask.js`, `activeLocationTask.js`,
  `backgroundTrackingService.js` (`persistDriverStatus`), `src/store/driversSlice.js`,
  `geofenceEngine.js`.
- **Recommended change:** (a) Centralize status transitions through one funnel and make
  `currentZoneId` a derived consequence of status (cleared when not active/staged). (b) Treat
  work-area load failure as an explicit error state (telemetry + UI), not silent passive; consider
  trusting a polygon-confirmed staging-zone entry for `staged` when the work area is unavailable.
- **Risk:** touches the core machine — needs careful regression on all transitions.
- **Test plan:** QA-04/05/06/14 in `real-device-qa-plan.md`; unit tests for transition table.
- **Difficulty:** L · **Dependencies:** none (foundational).

### F0-2 — Make forced heartbeat actually write on promotion  *(R-03)*
- **Problem:** `force:true` is discarded while status is passive (guard precedes force).
- **Affected files:** `src/lib/presenceHeartbeat.js`.
- **Recommended change:** Allow a forced write when an explicit STAGING/UNKNOWN classification + zone
  is supplied, or guarantee the STAGED promotion is awaited and reflected before forcing.
- **Risk:** low; keep passive auto-heartbeats blocked.
- **Test plan:** unit test forced write at promotion; QA-04.
- **Difficulty:** S · **Dependencies:** F0-1 (status funnel).

### F0-3 — Android/Samsung background reliability  *(R-04)*
- **Problem:** Battery optimization can stop the tasks → no promotion/heartbeat.
- **Affected files:** `app.config.js`, `backgroundTrackingService.js`, onboarding screens.
- **Recommended change:** Request battery-optimization exemption; add onboarding step to set the app
  "Unrestricted" on Samsung; verify foreground service stays alive; surface a throttled warning.
- **Risk:** OEM variance; needs device matrix testing.
- **Test plan:** QA-05/06/07/14 on Samsung with saver on/off.
- **Difficulty:** M · **Dependencies:** none.

---

## P1 — Reliability

### F1-1 — Field debug panel  *(R-15)*
- **Problem:** Couldn't diagnose the Samsung bug from the device.
- **Files:** `TrackingDebugPanel.jsx`, `trackingDebug.js`.
- **Change:** add fields from `gps-background-tracking-analysis.md` §7 (work-area loaded, last task
  run, heartbeat result, Redux-vs-DB zone divergence).
- **Risk:** low. **Test:** visual on device. **Difficulty:** M. **Deps:** none.

### F1-2 — Admin zone/system health checks  *(R-09)*
- **Files:** `admin/src/lib/zoneHealth.js`, `SystemCheckPage.jsx`.
- **Change:** add checks from `geofence-zone-model-analysis.md` §5 (geometry valid, inside work area,
  test-name detection, coming-soon ⇒ inactive). **Risk:** low. **Difficulty:** M. **Deps:** none.

### F1-3 — Lock down `driver_presence` reads  *(R-06)*
- **Files:** migration (future), RLS. **Change:** restrict SELECT to admin/service; aggregate-only
  for drivers. **Risk:** must not break live counts (RPC is SECURITY DEFINER, unaffected).
  **Difficulty:** S. **Deps:** none.

### F1-4 — Verify/secure visit lifecycle writes  *(R-07, R-08)*
- **Files:** RLS WITH CHECK (006), `zone_departures` write path, `behavioralClassifier`.
- **Change:** fix soft-delete WITH CHECK; confirm departures + dwell always written.
  **Difficulty:** M. **Deps:** none.

---

## P2 — Maintainability

### F2-1 — Central status state machine  *(R-02)*
- **Change:** one module owns transitions; all tasks/UI dispatch intents, not raw `setStatus`.
  **Files:** new `statusMachine` + refactor of all writers. **Difficulty:** L. **Deps:** F0-1.

### F2-2 — Remove/disable legacy `DriverToggle`  *(R-10)*
- **Files:** `DriverToggle.jsx`, screens referencing it. **Difficulty:** S. **Deps:** F0-1.

### F2-3 — Unify staleness windows + document source of truth  *(R-11, R-12)*
- **Files:** `constants.js`, `DriversPage.jsx`, `zoneHealth.js`, `ZoneListItem.jsx`, schema.sql doc.
  **Difficulty:** S. **Deps:** none.

### F2-4 — Add unit/integration tests
- **Change:** transition table tests, heartbeat-gate tests, RPC count tests (pgTAP/SQL).
  **Difficulty:** M. **Deps:** F0-1, F0-2.

---

## P3 — Product polish

### F3-1 — Honest UI messaging  *(R-05, R-14)*
- "Not counted yet" vs "Staged"; separate "client not refreshing" from "insufficient data"; label
  "You are here" as GPS-nearest unless status+presence agree. **Files:** `ZoneListItem.jsx`,
  `HomeScreen.jsx`, `AutoStatusBar.jsx`. **Difficulty:** M. **Deps:** F0-1.

### F3-2 — Driver-facing status/confidence explanations
- Explain confidence ("based on N recent trips") and why a button is disabled. **Difficulty:** S.

### F3-3 — Wait-time algorithm improvements
- Per-zone calibration, airport-specific logic, configurable windows. **Files:** future migration of
  `get_zone_live_stats`. **Difficulty:** L. **Deps:** F1-4 (reliable departures).

### F3-4 — Admin alerts + QA dashboard
- Alert on zones stuck INSUFFICIENT_DATA, drivers staged-but-not-counted. **Difficulty:** M.

### F3-5 — Geofence scaling beyond top-20  *(R-13)*
- Proximity-prioritized registration as zone count grows. **Difficulty:** M.

---

## Suggested order

1. **F0-1, F0-2, F0-3** (make counts correct + reliable on Samsung) — do first.
2. **F1-1** (debug panel) in parallel — accelerates validation of everything else.
3. **F1-2, F1-3, F1-4** (health checks, privacy, lifecycle).
4. **F2-x** (centralize, remove legacy toggle, unify staleness, tests).
5. **F3-x** (UX + algorithm polish).
