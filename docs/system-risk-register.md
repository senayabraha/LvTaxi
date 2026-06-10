# LV Taxi System Risk Register

Analysis-only documentation. Risks are open until verified and fixed in an approved implementation phase.

## Risk R-001

**Title:** Driver physically in staging not counted

**Severity:** Critical

**Subsystem:** Driver status / presence / live count

**Description:** A driver can be inside a staging zone but remain uncounted if status is passive, presence heartbeat is blocked, `driver_presence` is stale/missing, or `current_zone_id` is not written consistently.

**Evidence:** Samsung Terminal 1 report: Passive (far), You are here, 0 car, Data stale, Go online first.

**Files involved:** `activeLocationTask.js`, `passiveLocationTask.js`, `presenceHeartbeat.js`, `driversSlice.js`, `ZoneListItem.jsx`, `HomeScreen.jsx`.

**Database objects involved:** `drivers`, `driver_presence`, `active_driver_presence`, `get_zone_live_stats()`.

**How to reproduce:** Stand inside Terminal 1 staging with one test driver and compare mobile status/current zone/count to SQL presence row.

**Impact:** Core product failure; drivers cannot trust queue counts.

**Recommended fix:** Centralize status transition and atomically write Redux, `drivers`, and `driver_presence`; add UI mismatch warnings.

**Priority:** P0

**Owner:** Mobile + Supabase

**Status:** Open

---

## Risk R-002

**Title:** Passive status with local current zone creates false “You are here” UI

**Severity:** Critical

**Subsystem:** UI state consistency

**Description:** `ZoneListItem` shows “You are here” based only on Redux `currentZoneId`, not on status or live presence eligibility.

**Evidence:** HomeScreen passes `isCurrentZone` from `currentZoneId`; ZoneListItem renders “You are here” without checking status or presence.

**Files involved:** `HomeScreen.jsx`, `ZoneListItem.jsx`, `driversSlice.js`.

**Database objects involved:** `driver_presence`, `active_driver_presence`.

**How to reproduce:** Set/currently retain `currentZoneId` while status is `passive_far`; observe top status passive and zone highlight.

**Impact:** Misleading UX; user believes they are in queue but count is 0.

**Recommended fix:** Require status/presence agreement for counted labels; add “GPS detected but not counted” state.

**Priority:** P0

**Owner:** Mobile UI

**Status:** Open

---

## Risk R-003

**Title:** Heartbeat guard blocks forced presence writes while status is passive

**Severity:** Critical

**Subsystem:** Presence heartbeat

**Description:** `maybeSendPresenceHeartbeat(force: true)` still returns false unless status is `active` or `staged`. This is safe but fragile when status and heartbeat are not atomic.

**Evidence:** `presenceHeartbeat.js` checks `isHeartbeatStatus(store.getState().drivers.status)` before throttling/force behavior.

**Files involved:** `presenceHeartbeat.js`, `geofenceEngine.js`, `passiveLocationTask.js`, `ImStagingButton.jsx`.

**Database objects involved:** `driver_presence`.

**How to reproduce:** Attempt a forced heartbeat while Redux status is `passive_far`.

**Impact:** Driver may never count even after zone detection if status was not promoted first.

**Recommended fix:** Central transition API should set status before heartbeat or provide a safe atomic staged transition.

**Priority:** P0

**Owner:** Mobile architecture

**Status:** Open

---

## Risk R-004

**Title:** Work-area polygon failure prevents all activation

**Severity:** Critical

**Subsystem:** Work-area geometry

**Description:** If no active work-area polygon loads, `isInsideWorkAreaPolygon()` returns false and the app fails safe to passive.

**Evidence:** `workAreaGeometry.js` returns false when polygon cache is empty.

**Files involved:** `workAreaGeometry.js`, `passiveLocationTask.js`, `activeLocationTask.js`, `backgroundTrackingService.js`.

**Database objects involved:** `work_areas`.

**How to reproduce:** Disable/delete active work area or block work-area query; open app inside Terminal 1.

**Impact:** App will not auto-activate/stage anyone.

**Recommended fix:** Add admin system check, mobile debug warning, and real-device validation for work-area coverage.

**Priority:** P0

**Owner:** Supabase/admin/mobile

**Status:** Open

---

## Risk R-005

**Title:** Terminal staging polygon does not contain real queue location

**Severity:** High

**Subsystem:** Geofence geometry

**Description:** Bad or incomplete Terminal 1/T3 polygons can prevent staged detection or make fallback/center logic inconsistent.

**Evidence:** Staging detection relies on selected polygon, with fallback only for polygon-less zones.

**Files involved:** `workAreaGeometry.js`, `geofenceEngine.js`, admin zone builder.

**Database objects involved:** `staging_zones.drawn_polygon`, `driven_polygon`, `use_driven_polygon`.

**How to reproduce:** Compare physical GPS fix against selected Terminal 1 polygon.

**Impact:** Airport counts fail at the highest-value zones.

**Recommended fix:** Add geometry validation, map QA, and Terminal-specific field tests.

**Priority:** P0

**Owner:** Admin/geospatial

**Status:** Open

---

## Risk R-006

**Title:** Android/Samsung background task delayed or stopped

**Severity:** High

**Subsystem:** Background tracking

**Description:** Samsung battery optimization can delay passive/active background location tasks, causing stale presence and incorrect counts.

**Evidence:** Background task reliability depends on OS delivery, foreground service, permissions, and battery settings.

**Files involved:** `backgroundTrackingService.js`, `activeLocationTask.js`, `passiveLocationTask.js`, app config.

**Database objects involved:** `driver_presence.last_ping_at`.

**How to reproduce:** Test staged driver with Samsung screen locked/backgrounded under optimized battery settings.

**Impact:** Counts drop after 90 seconds even while driver is physically staged.

**Recommended fix:** Add battery optimization warning, debug task timestamps, and QA device setup instructions.

**Priority:** P0/P1

**Owner:** Mobile platform

**Status:** Open

---

## Risk R-007

**Title:** Legacy DriverToggle conflicts with automatic tracking

**Severity:** High

**Subsystem:** Mobile status control

**Description:** `DriverToggle.jsx` manually writes `active`/`off_duty`, starts foreground tracking, and bypasses automatic polygon state machine.

**Evidence:** DriverToggle directly dispatches status and writes `drivers.status`.

**Files involved:** `DriverToggle.jsx`, `locationEngine.js`, `geofenceEngine.js`, `driversSlice.js`.

**Database objects involved:** `drivers.status`, `driver_presence`.

**How to reproduce:** Use legacy toggle and compare status to physical work-area position.

**Impact:** Status and count pipeline can be corrupted by manual state.

**Recommended fix:** Remove from production or convert to tracking-enabled toggle that calls the central state machine.

**Priority:** P0/P1

**Owner:** Mobile

**Status:** Open

---

## Risk R-008

**Title:** RLS/RPC security or grants block presence writes

**Severity:** High

**Subsystem:** Supabase RPC/RLS

**Description:** Presence RPCs are secured with ownership checks. Misconfigured auth/session or grants can cause writes to fail silently in UI.

**Evidence:** `upsert_driver_presence()` raises if `p_driver_id` differs from `auth.uid()` unless service role.

**Files involved:** `zoneStatsEngine.js`, `presenceHeartbeat.js`.

**Database objects involved:** `upsert_driver_presence`, `clear_driver_presence`, `driver_presence`, RLS policies.

**How to reproduce:** Run heartbeat with mismatched/expired auth session; inspect console and DB.

**Impact:** Driver remains uncounted.

**Recommended fix:** Surface RPC write result/error in debug panel and Sentry without PII GPS.

**Priority:** P1

**Owner:** Supabase/mobile

**Status:** Open

---

## Risk R-009

**Title:** `schema.sql` is stale compared with migrations

**Severity:** Medium

**Subsystem:** Database documentation/deployability

**Description:** Baseline schema still shows obsolete status default `browsing`, while modern migrations use automatic statuses.

**Evidence:** `schema.sql` Phase 1 baseline conflicts with migration 014.

**Files involved:** `supabase/schema.sql`, `supabase/migrations/*`.

**Database objects involved:** `drivers.status` constraint/default.

**How to reproduce:** Compare `schema.sql` with deployed constraints.

**Impact:** New environments can be seeded incorrectly if schema.sql is trusted alone.

**Recommended fix:** Generate current schema snapshot after migrations and document migration order.

**Priority:** P1

**Owner:** Supabase

**Status:** Open

---

## Risk R-010

**Title:** Active/coming-soon/test zones pollute production

**Severity:** High

**Subsystem:** Zone configuration

**Description:** Test or coming-soon zones can appear in some pipelines if filters are inconsistent.

**Evidence:** Some code excludes coming-soon; `get_zone_live_stats()` reviewed filter uses `active = true` only.

**Files involved:** `useZones.js`, `workAreaGeometry.js`, `geofenceEngine.js`, SQL RPC.

**Database objects involved:** `staging_zones`, `get_zone_live_stats()`.

**How to reproduce:** Query active zones with names like test/demo/New York and coming-soon active conflicts.

**Impact:** Wrong geofences, confusing UI, wrong counts.

**Recommended fix:** Admin health checks and stricter RPC filters for driver-facing stats.

**Priority:** P1

**Owner:** Admin/Supabase

**Status:** Open

---

## Risk R-011

**Title:** Wait-time confidence misunderstood as live count confidence

**Severity:** Medium

**Subsystem:** Wait-time algorithm/UI

**Description:** A one-driver test should show count 1 but may still show insufficient wait data. UI can confuse these concepts.

**Evidence:** Wait status depends on dwell/departures; live count depends on presence.

**Files involved:** `ZoneListItem.jsx`, `get_zone_live_stats()`.

**Database objects involved:** `zone_visits`, `zone_departures`, `driver_presence`.

**How to reproduce:** Stage one driver with no departures.

**Impact:** User may think app is broken when only wait estimate is learning.

**Recommended fix:** Separate “live count confirmed” from “wait estimate learning.”

**Priority:** P2

**Owner:** Product/UI

**Status:** Open

---

## Risk R-012

**Title:** Open zone visits cause wrong queue position

**Severity:** Medium

**Subsystem:** Visit processing

**Description:** Driver position uses open `zone_visits` entered before the local entry time. Missed exits or stale visits can produce false Position #1/#N.

**Evidence:** `getDriverPositionInZone()` counts open visits in `zone_visits`, not active presence.

**Files involved:** `zoneStatsEngine.js`, `geofenceEngine.js`, `visitReconciler.js`.

**Database objects involved:** `zone_visits`.

**How to reproduce:** Leave a stale open visit and re-enter a zone.

**Impact:** Misleading queue position.

**Recommended fix:** Reconcile open visits and align position with active presence.

**Priority:** P1/P2

**Owner:** Mobile/Supabase

**Status:** Open

---

## Risk R-013

**Title:** Excessive or poorly controlled Supabase writes at scale

**Severity:** Medium

**Subsystem:** Backend scalability

**Description:** Presence heartbeat is intentionally 25 seconds, but multiple write paths and future lowering to 3–5 seconds could overload Supabase.

**Evidence:** Constants warn against lowering direct Supabase heartbeat cadence.

**Files involved:** `constants.js`, `presenceHeartbeat.js`, `locationWritePolicy.js`.

**Database objects involved:** `driver_presence`, `zone_visits`, `trajectories`.

**How to reproduce:** Simulate many active drivers with 5s heartbeat.

**Impact:** Cost, latency, write bottlenecks.

**Recommended fix:** Keep 25s Supabase heartbeat; future Redis/WebSocket/MQTT hot path for high-frequency updates.

**Priority:** P2

**Owner:** Architecture/backend

**Status:** Open

---

## Risk R-014

**Title:** Location privacy exposure in debug/logging/trajectories

**Severity:** High

**Subsystem:** Privacy/security

**Description:** The app handles precise location and trajectory data. Debug panels and logs can expose sensitive driver movement.

**Evidence:** App uses Sentry filtering for geo keys, but DB stores trajectories/presence.

**Files involved:** `App.jsx`, `trajectoryRecorder.js`, `trackingDebug.js`, Sentry config.

**Database objects involved:** `driver_presence`, `trajectories`, `zone_visits`.

**How to reproduce:** Inspect logs/debug/database location fields.

**Impact:** Privacy risk and user trust issue.

**Recommended fix:** Minimize logs, redact GPS in error reporting, restrict admin access, document retention policy.

**Priority:** P1

**Owner:** Security/backend/mobile

**Status:** Open

---

## Risk R-015

**Title:** Insufficient debug visibility during field testing

**Severity:** High

**Subsystem:** QA/debugging

**Description:** Without task status, work-area result, detected zone, and heartbeat write result, field testers cannot diagnose why a driver is not counted.

**Evidence:** Samsung bug requires distinguishing GPS, work-area, status, heartbeat, and RPC failures.

**Files involved:** `TrackingDebugPanel.jsx`, `trackingDebug.js`, admin SystemCheck.

**Database objects involved:** all live count pipeline objects.

**How to reproduce:** Run Terminal 1 test and try to determine failure reason from current UI alone.

**Impact:** Slow debugging; false fixes.

**Recommended fix:** Expand debug panel and admin diagnostics before major algorithm changes.

**Priority:** P1

**Owner:** QA/mobile/admin

**Status:** Open
