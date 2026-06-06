# LV Taxi — GPS & Background Tracking Analysis

> Analysis-only. Covers foreground/background acquisition, cadences, exit grace, Android/Samsung
> reliability, and recommended debug fields.

---

## 1. Foreground tracking

- `src/lib/locationEngine.js` runs `watchPositionAsync`, smooths fixes, and dispatches
  `setLocation` into Redux; on each smoothed fix it calls `presenceHeartbeatFromLocation(point)`
  (`presenceHeartbeat.js:88`).
- GPS may sample as often as ~1 s (HIGH mode) locally; this is decoupled from backend writes — see
  the three-concept note in `constants.js:109-159` (GPS acquisition vs presence heartbeat vs
  trajectory persistence).
- Foreground heartbeat path: smoothed fix → `presenceHeartbeatFromLocation` → guarded by
  `isHeartbeatStatus` (`presenceHeartbeat.js:94`) → throttled `maybeSendPresenceHeartbeat` (25 s).

## 2. Background tracking

- `src/lib/backgroundTracking/backgroundTrackingService.js` orchestrates start/stop, exposes
  `persistDriverStatus` (the status funnel, `:71`) and `reconcileTrackingOnAppLaunch` (`:268-314`).
- Tasks are defined via Expo `TaskManager` (`passiveLocationTask.js`, `activeLocationTask.js`,
  geofence task `LVTAXI_GEOFENCE_TASK` in `geofenceEngine.js:16`). Task names in
  `trackingTaskNames.js`. Registration happens at app start (`App.jsx`).
- Two location tasks: **passive** (low cadence outside work area) and **active** (5 s inside / staged).
  The service swaps between them (`stopPassiveTracking`/`startActiveTracking`).

## 3. Passive tracking

- Cadence: `PASSIVE_FAR_INTERVAL_MS` 20 min, `PASSIVE_NEAR_INTERVAL_MS` 5 min (`constants.js:209`).
  Foreground-service options also set `distanceInterval` 750/150 m.
- Classification: `classifyPassiveDistance(lat,lng)` compares distance to the work-area polygon
  against `PASSIVE_NEAR_THRESHOLD_METERS` (3 km) (`workAreaGeometry.js`).
- Upgrade: when `isInsideWorkAreaPolygon` becomes true, the passive task detects a zone, sets
  `active`/`staged`, switches to the active task, and forces an immediate heartbeat
  (`passiveLocationTask.js:70-108`).
- Passive drivers **do not heartbeat** by design (`isHeartbeatStatus` excludes them), so they cost
  no backend writes and never count.

## 4. Active tracking

- Cadence: `ACTIVE_LOCATION_INTERVAL_MS` 5 s, HIGH accuracy, `activityType:
  AutomotiveNavigation`, `pausesUpdatesAutomatically:false` (foreground-service options in
  `backgroundTrackingService.js:121-147`).
- Detects zone/status changes; `staged` when inside a zone polygon else `active`
  (`activeLocationTask.js:91/97`).
- Heartbeats every ~25 s with the current zone/classification.
- Outside work area: transitions to exit grace via `exitGraceManager`.

## 5. Exit grace

- **Timestamp-based, not `setTimeout`** — survives task restarts and app relaunch. Persisted to
  `drivers.work_area_exit_started_at` (DB) and Redux `workAreaExitStartedAt`
  (`driversSlice.js:27,94-99`).
- `evaluateExitGrace` computes `elapsed = now - startedAt`; if `>= WORK_AREA_EXIT_GRACE_MS` (30 min)
  → `completeExitToPassive` (presence cleared via `clear_driver_presence`, status → passive).
- Re-entering the work area within the window cancels grace (`clearExitGrace`) and returns to
  active/staged.
- Presence is **cleared** (not written) during grace, so EXIT_GRACE never appears in live counts.

## 6. Android / Samsung reliability

| Question | Finding |
|---|---|
| Background location when screen locked? | Yes if the foreground service stays alive (configured). |
| Works when backgrounded? | Yes via foreground service; geofence also OS-level. |
| App swiped away? | OS may stop the foreground service/tasks; geofence may still wake but heartbeats stop. |
| Samsung battery optimization? | **High risk.** No `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` / OEM battery-exemption flow. Samsung "Sleeping apps"/"Deep sleep" can kill the task. |
| Foreground service notification configured? | Yes — both passive and active set `foregroundService` notification (`backgroundTrackingService.js:121-147`). |
| Android permissions correct? | `ACCESS_FINE/COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` (`app.config.js:74-81`); `isAndroidBackgroundLocationEnabled:true` (`app.config.js:40`). |
| Background permission requested correctly? | Plugin config present; runtime request flow in `LocationPermissionScreen.jsx` should request "Always". Verify it escalates from When-In-Use to Always (Android 11+ requires a separate step). |
| Could Android be preventing the task? | **Yes** — battery optimization is the leading reliability gap; on a fresh Samsung the active/passive task may not wake, leaving status stuck at the reconciled value (relevant to the Terminal 1 bug, hypothesis #2). |

iOS: `UIBackgroundModes:['location','fetch']`, "Always" usage strings present (`app.config.js:57-65`).

## 7. Recommended debug fields (do not implement yet)

Surface in `TrackingDebugPanel.jsx` / `trackingDebug.js`:

- Current GPS: lat/lng/accuracy/speed/heading + fix timestamp.
- Last background-task run timestamp (passive and active separately).
- Which task is running (passive/active/geofence) + cadence.
- Inside work area? (yes/no) + work-area polygon load status (loaded/empty/error).
- Detected staging zone (and whether polygon-verified vs circle-only).
- Last heartbeat timestamp + last `upsert_driver_presence` result/error.
- Last `get_zone_live_stats` fetch time + RPC error.
- Battery-optimization status / "app is being throttled" warning.
- Redux `currentZoneId` vs DB `driver_presence.current_zone_id` (divergence flag).

See `fix-roadmap.md` P1 for the debug-panel work item.
