# GPS and Background Tracking Analysis

Analysis-only documentation. No implementation changes are made here.

## 1. Foreground tracking

`src/lib/locationEngine.js` owns foreground `Location.watchPositionAsync`.

Key behavior:

- Requests foreground permission and attempts background permission.
- Uses `watchPositionAsync` with three modes:
  - `HIGH`: `BestForNavigation`, 1s, small distance interval.
  - `LOW`: balanced, 5s.
  - `PASSIVE`: balanced, 20 minutes.
- Applies Kalman smoothing to latitude/longitude.
- Derives speed/heading/acceleration when native values are missing.
- Dispatches smoothed location to Redux via `drivers.setLocation` roughly every second.
- Calls `presenceHeartbeatFromLocation(point)` on every fix; heartbeat throttling is inside `presenceHeartbeat.js`.
- Auto-switches between HIGH and LOW when stationary/moving, except when in PASSIVE mode.

Important limitation: foreground location engine updates location and can heartbeat only if Redux status is already `active` or `staged`. It is not the authoritative background state machine.

## 2. Background tracking

`src/lib/backgroundTracking/backgroundTrackingService.js` owns Expo background task lifecycle.

Task definitions are imported at top-level in `App.jsx`:

- `src/lib/backgroundTracking/passiveLocationTask.js`
- `src/lib/backgroundTracking/activeLocationTask.js`

This is correct for Expo TaskManager because tasks must be defined at module scope before the OS delivers background events.

The service starts/stops two location-update tasks:

- Passive task: outside work area; slow cadence.
- Active task: inside work area, staged, or exit grace; faster cadence or light grace cadence.

It also provides:

- `persistDriverStatus(driverId, status, extra)` to mirror status into Redux and update the `drivers` row.
- `reconcileTrackingOnAppLaunch()` to recover task state after app launch.
- `enableTrackingFromUI()` / `disableTrackingFromUI()`.

## 3. Passive tracking

Passive tracking runs while the driver is outside the work area.

Expected modes:

- `passive_far`: about 20-minute GPS cadence.
- `passive_near`: about 5-minute GPS cadence.

The passive task:

1. Reads the latest background location.
2. Gets the authenticated driver id.
3. Refreshes work-area/staging-zone cache.
4. Checks `isInsideWorkAreaPolygon(lat, lng)`.
5. If inside work area, detects staging zone.
6. Persists `active` or `staged`.
7. Starts active tracking.
8. Forces one immediate heartbeat.
9. If still outside, classifies far/near and updates status/cadence.

Passive drivers do not heartbeat by design. Therefore, if a real driver is physically inside Terminal 1 but the work-area check fails, the system will remain passive and no queue count will be written.

## 4. Active tracking

The active task runs for:

- `active`
- `staged`
- `exit_grace`

The active task:

1. Reads GPS from Expo TaskManager.
2. Refreshes work-area/staging-zone cache.
3. If outside work area, delegates to `exitGraceManager.evaluateExitGrace()`.
4. If inside work area, clears exit grace.
5. Detects staging zone from point.
6. Computes desired status: `staged` if zone exists, otherwise `active`.
7. Sets Redux current zone.
8. Persists status/zone to `drivers` only if status or zone changed.
9. Calls `maybeSendPresenceHeartbeat()`.

Heartbeat behavior:

- `staged` -> zone id + `STAGING` classification.
- `active` -> null zone + `ACTIVE` classification.
- Heartbeat is throttled to about 25 seconds unless forced.

## 5. Exit grace

`exitGraceManager.js` uses timestamp-based grace, not `setTimeout`, because background JS timers are unreliable when suspended or relaunched.

Fields/state:

- Redux `workAreaExitStartedAt`.
- Database `drivers.work_area_exit_started_at`.
- `drivers.status = exit_grace`.
- `drivers.current_zone_id = null`.

Behavior:

1. On leaving the work area, start grace and clear current zone.
2. Persist `exit_grace` and exit start time.
3. Clear `driver_presence` immediately so the driver is not counted.
4. Start active task with lighter cadence.
5. On re-entry, clear grace and return to active/staged.
6. On expiry after 30 minutes, switch to passive far/near and stop active tracking.

## 6. Android/Samsung reliability

### Backgrounded / locked

Expo background location can deliver updates while backgrounded or locked, subject to OS restrictions and permission settings. The repo already configures Android foreground-service notifications in passive and active options. Active tracking uses `foregroundService` notification text and high accuracy when not in grace.

### App swiped away / force-closed

The code correctly notes that tracking is not guaranteed after force-close. QA and UI must not promise force-close reliability.

### Samsung battery optimization

Samsung devices are aggressive about background restrictions. Failure modes include:

- Passive task delayed beyond expected cadence.
- Active task not delivering updates when locked.
- Foreground service notification suppressed/misconfigured.
- Background permission not granted as “Allow all the time.”
- Battery Saver / Sleeping Apps / Deep Sleeping Apps stopping the process.

### Permission configuration questions to verify

The repository analysis should verify in implementation phase:

- `app.json` / Expo config contains Android foreground/background location permissions.
- Android foreground service permissions are included.
- iOS `UIBackgroundModes` includes location.
- Permission screen clearly asks for background/always permission.
- Real Samsung settings are checked: unrestricted battery, background activity allowed, location allowed all the time.

## 7. Failure modes found

1. Passive task cadence can be too slow for field testing unless the app is foregrounded or reconciliation gets a fresh fix.
2. `reconcileTrackingOnAppLaunch()` upgrades to `active` if inside work area, but it does not immediately detect staging zone; it sets `ACTIVE` from work-area only. The active task must then run to detect `STAGED`.
3. Work-area cache failure makes all drivers fail safe to outside/passive.
4. Foreground tier manager duplicates geometry and GPS-mode logic, which can change GPS mode without owning status transitions.
5. Manual `DriverToggle` can start foreground tracking and write legacy statuses outside the automatic background task lifecycle.
6. `maybeSendPresenceHeartbeat(force)` still requires heartbeat-eligible status, so ordering bugs suppress writes.

## 8. Debugging fields recommended

Add these in a future implementation phase to `TrackingDebugPanel` and admin system diagnostics:

| Field | Why it matters |
|---|---|
| current GPS lat/lng/accuracy/speed/heading | Confirms device fix and accuracy. |
| raw vs smoothed GPS | Identifies filter drift. |
| last foreground fix time | Confirms foreground watcher. |
| last background task run time | Confirms TaskManager delivery. |
| active/passive task running flags | Confirms OS subscriptions. |
| active task cadence | Distinguishes active vs exit grace. |
| passive mode far/near | Confirms passive cadence. |
| inside work area yes/no | Explains passive vs active. |
| active work-area polygon count | Catches missing work-area cache. |
| detected staging zone id/name | Explains staged vs active. |
| last status transition | Shows why status changed. |
| last heartbeat attempted time | Shows heartbeat path. |
| last heartbeat success/error | Shows Supabase/RPC write failure. |
| current `driver_presence` age | Explains counted vs stale. |
| Supabase RPC error text | Catches RLS/security-definer issues. |
| battery optimization warning | Crucial for Samsung. |
| permission summary | Foreground/background/precise status. |

## 9. Real-device recommendations

- Test Samsung with app foreground for 2 minutes first to eliminate background-task delay as a variable.
- Then test background and locked states.
- Check whether `lastBackgroundLocationAt` advances.
- Check whether `workAreaPolygonCount > 0`.
- Check whether detected zone id/name is Terminal 1.
- Check whether heartbeat is attempted and succeeds.
- Check Supabase rows directly during test.

## 10. Primary GPS-related hypothesis for Terminal 1 bug

The strongest GPS/background hypothesis is that the device never executed the status transition from passive to active/staged because the passive background task was delayed or the work-area polygon check failed. Since passive status blocks heartbeat, the driver could physically be in Terminal 1 while still not counted.
