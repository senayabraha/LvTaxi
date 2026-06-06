# Driver Status State Machine Analysis

Analysis-only documentation. This document traces the current and expected LV Taxi driver status model and identifies risks. No code changes are made here.

## 1. Status inventory

The current automatic statuses are defined in `src/lib/constants.js`:

- `tracking_disabled`
- `passive_far`
- `passive_near`
- `active`
- `staged`
- `exit_grace`
- `off_duty` legacy compatibility

The database status constraint is widened in migration `014_background_tracking_states.sql`. New drivers default to `tracking_disabled`.

## 2. Status-by-status analysis

### `tracking_disabled`

- Meaning: tracking cannot run due to missing permission, logout, disabled flag, or account state.
- Set by: `driversSlice.clearProfile`, `setTrackingEnabled(false)`, `reconcileTrackingOnAppLaunch`, `disableTrackingFromUI`.
- Files/functions: `driversSlice.js`, `backgroundTrackingService.js`.
- Database: `drivers.status`, `drivers.tracking_enabled`, `drivers.current_zone_id`.
- Redux: `drivers.status`, `trackingEnabled`, `currentZoneId`.
- Heartbeat: no.
- Counts: no.
- Entry causes: logout, permission revoked, user disables tracking, reconciliation fails permission check.
- Exit causes: permissions restored and reconciliation runs.
- Failure risks: presence may remain if not cleared on every disabled path.
- UI: AutoStatusBar shows Tracking off.
- Admin: should show disabled/offline based on no fresh presence.

### `passive_far`

- Meaning: driver is outside active work area and far from boundary.
- Set by: passive task, launch reconciliation, exit grace expiry.
- Files/functions: `passiveLocationTask`, `backgroundTrackingService.reconcileTrackingOnAppLaunch`, `exitGraceManager.completeExitToPassive`.
- Database: `drivers.status`.
- Redux: `status`, usually null `currentZoneId`.
- Heartbeat: no.
- Counts: no.
- Entry causes: outside work area with distance over passive-near threshold, no position fail-safe.
- Exit causes: moves near boundary or inside work area.
- Failure risks: if `work_areas` cache is empty, an inside driver can be incorrectly passive_far.
- UI: Passive (far).
- Admin: no fresh presence; likely stale/offline.

### `passive_near`

- Meaning: driver is outside active work area but near boundary.
- Set by: same as passive_far.
- GPS: passive task with faster cadence than passive_far.
- Heartbeat/count: no.
- Entry causes: outside work area within configured threshold.
- Exit causes: moves far away or enters work area.
- Failure risks: inaccurate work-area polygon can keep a driver in passive_near outside the wrong boundary.

### `active`

- Meaning: driver is inside active work area, but not inside staging zone.
- Set by: active task, passive task auto-upgrade, launch reconciliation, manual/legacy DriverToggle.
- Files/functions: `activeLocationTask`, `passiveLocationTask`, `backgroundTrackingService`, `DriverToggle`.
- Database: `drivers.status = active`, `drivers.current_zone_id = null`.
- Redux: `status = active`, `currentZoneId = null`.
- Heartbeat: yes; `classification = ACTIVE`, `current_zone_id = null`.
- Counts: no.
- Entry causes: enters work area but no staging-zone detection.
- Exit causes: staged, exit_grace, tracking_disabled.
- Failure risks: manual toggle can set active without polygon proof; `active` with stale/no heartbeat causes admin contradiction.

### `staged`

- Meaning: driver is inside a staging-zone polygon and should count while presence is fresh.
- Set by: active task, passive task auto-upgrade, geofence enter, ImStagingButton.
- Files/functions: `activeLocationTask`, `passiveLocationTask`, `geofenceEngine.completeHandleEnter`, `ImStagingButton`.
- Database: `drivers.status = staged`, `drivers.current_zone_id = zone_id`, `driver_presence.current_zone_id = zone_id`.
- Redux: `status = staged`, `currentZoneId = zone_id`, `isInsideZone = true`.
- Heartbeat: yes; `classification = STAGING`.
- Counts: yes, only if `driver_presence` row is fresh and accepted by `active_driver_presence` / `get_zone_live_stats`.
- Entry causes: polygon-confirmed staging detection or manual confirmation.
- Exit causes: leaving staging zone but still in work area, leaving work area, disabled/logout.
- Failure risks: `currentZoneId` may be set without fresh presence, creating “You are here” with 0 count.

### `exit_grace`

- Meaning: driver recently left work area; system waits before dropping to passive to avoid GPS flapping.
- Set by: `exitGraceManager.evaluateExitGrace/startExitGrace`.
- GPS: active task at lighter cadence.
- Heartbeat: no; presence is cleared immediately.
- Counts: no.
- Database: `drivers.work_area_exit_started_at`, `drivers.status`, null `current_zone_id`.
- Redux: `workAreaExitStartedAt`, `status`, null `currentZoneId`.
- Entry causes: active/staged driver leaves work-area polygon.
- Exit causes: re-entry to active/staged or expiry to passive.
- Failure risks: if clear-presence RPC fails, stale presence may remain until TTL.

### `off_duty` legacy

- Meaning: old manual off-duty state retained for compatibility.
- Set by: `DriverToggle.jsx`.
- Heartbeat/count: no.
- Risk: it can break the new automatic architecture by persisting a legacy value and starting foreground/passive tracking outside the central background state model.
- Recommendation: remove from user-facing control path or migrate to `tracking_disabled`/automatic passive states.

## 3. Transition trace

| Transition | Expected owner | Current files involved | Notes |
|---|---|---|---|
| `tracking_disabled -> passive_far` | launch/permission reconciliation | `backgroundTrackingService` | If permission granted but outside/no GPS, passive_far is safe fallback. |
| `tracking_disabled -> passive_near` | launch reconciliation | `backgroundTrackingService` | Requires work-area cache and GPS distance. |
| `tracking_disabled -> active` | launch reconciliation | `backgroundTrackingService` | Requires inside work-area polygon. |
| `passive_far -> passive_near` | passive task | `passiveLocationTask` | Changes passive cadence. |
| `passive_near -> passive_far` | passive task | `passiveLocationTask` | Changes passive cadence. |
| `passive_* -> active` | passive task | `passiveLocationTask` | Inside work area, no staging zone. |
| `passive_* -> staged` | passive task | `passiveLocationTask` | Inside work area and staging zone. |
| `active -> staged` | active task/geofence/manual | `activeLocationTask`, `geofenceEngine`, `ImStagingButton` | Needs one central transition API. |
| `staged -> active` | active task/geofence exit | `activeLocationTask`, `geofenceEngine` | Must clear zone and make presence ACTIVE/null-zone. |
| `active/staged -> exit_grace` | active task | `exitGraceManager` | Clears presence immediately. |
| `exit_grace -> active` | active task | `activeLocationTask.clearExitGrace` | Requires inside work area, no staging. |
| `exit_grace -> staged` | active task | `activeLocationTask` | Requires inside work area and staging zone. |
| `exit_grace -> passive_*` | exit grace manager | `exitGraceManager.completeExitToPassive` | After 30 minutes outside. |
| any -> `tracking_disabled` | permission/logout/user toggle | `backgroundTrackingService`, `driversSlice` | Should always clear presence. |
| `off_duty -> modern state` | migration/reconciliation | not centralized | Needs cleanup. |

## 4. Exact investigation questions

### 1. Is there one single source of truth for the status state machine?

No. The intended source is the automatic background-tracking architecture, but actual transitions are distributed across `backgroundTrackingService`, `passiveLocationTask`, `activeLocationTask`, `exitGraceManager`, `geofenceEngine`, `ImStagingButton`, `DriverToggle`, and generic Redux reducers.

### 2. Are status transitions centralized or spread across many files?

Spread across many files. This is a high-risk architectural issue.

### 3. Does `geofenceEngine.js` call `zoneEntered()` without setting status = staged?

The current implementation calls `zoneEntered(zoneId)` and then calls `persistDriverStatus(driverId, DRIVER_STATUS.STAGED, { current_zone_id: zoneId })`. A comment explicitly states this was added to avoid forced heartbeat being dropped while status is passive. That means this specific bug has likely already been addressed in `geofenceEngine`, but other paths can still create mismatches.

### 4. Can `currentZoneId` be set while status is still `passive_far`?

Yes, architecturally possible. `driversSlice.zoneEntered` and `setCurrentZone` can set the zone without enforcing status. A stale Redux state, geofence callback race, or manual code path can leave `currentZoneId` set while status remains passive.

### 5. Can UI show “You are here” while status is passive?

Yes. `HomeScreen` passes `isCurrentZone={item.zone.id === currentZoneId}` to `ZoneListItem`; it does not require `status === staged` or fresh `driver_presence`.

### 6. Can a driver be inside a staging zone but not counted because status is passive?

Yes. `maybeSendPresenceHeartbeat()` exits early unless Redux status is `active` or `staged`. If the driver is physically in staging but status is still `passive_far`, forced or normal heartbeat will be blocked.

### 7. Can `maybeSendPresenceHeartbeat()` block forced heartbeat writes because status is still passive?

Yes. The `force` flag bypasses throttling but does not bypass the `isHeartbeatStatus()` guard. This is correct for safety, but dangerous if status transition and heartbeat are not atomic.

### 8. Does `ImStagingButton` update all required fields?

Mostly, but not atomically. It dispatches `setStatus(staged)`, dispatches `zoneEntered`, calls `maybeSendPresenceHeartbeat(force)`, then updates the `drivers` row. This ordering helps the heartbeat guard pass, but database writes can partially fail. It also uses a 200m center-distance picker rather than polygon verification.

### 9. Does `DriverToggle.jsx` conflict with the automatic state machine?

Yes. It manually toggles between `off_duty` and `active`, starts foreground location tracking, starts geofencing, and writes `drivers.status` directly. It is legacy behavior and should not be part of the modern automatic status system.

### 10. Is `off_duty` still used anywhere in a way that can break new logic?

Yes. `DriverToggle.jsx` writes it, and admin filters still include `off_duty`. Since modern code expects passive/active/staged/exit_grace/tracking_disabled, legacy off-duty can create inconsistent UX and background task state.

## 5. Samsung Terminal 1 bug case study

Reported UI:

- “Passive (far)” at top.
- “You are here — Position #1” inside Terminal 1 card.
- “0 car”.
- “Data stale”.
- “Go online first to use staging” when pressing “I’m Staging”.

Expected:

- status = `staged`.
- Terminal 1 count = 1.
- fresh `driver_presence`.
- classification = `STAGING`.
- `current_zone_id = Terminal 1`.

### How this contradictory UI can happen

1. Top status comes from Redux `drivers.status` and can remain `passive_far`.
2. “You are here” comes from Redux `drivers.currentZoneId`, not from live presence or status agreement.
3. `0 car` comes from `get_zone_live_stats()` via `driver_presence`, not local Redux.
4. “Data stale” comes from stat `last_updated`/cache freshness and may show if live stats were not refreshed recently.
5. “Go online first” comes from `ImStagingButton` requiring status `active` or `staged`; passive status disables it.

### Root-cause hypothesis ranked by likelihood

1. **Work-area polygon/load failure caused status to stay passive, while stale/local currentZoneId highlighted Terminal 1.** If `work_areas` cache has zero active polygons or Terminal 1 is outside the active work-area polygon, the state machine fails safe to passive. Because passive does not heartbeat, count remains 0.
2. **Background task did not run or did not receive fresh GPS on Samsung.** Passive cadence can be slow, Android/Samsung battery restrictions may delay background tasks, and the driver may remain in old passive state until a foreground/active fix drives reconciliation.
3. **Redux `currentZoneId` was stale from a previous entry or geofence event.** UI highlight can survive without database presence agreement.
4. **Presence heartbeat was blocked by passive status.** Even if a zone was detected locally, heartbeat guard drops writes unless status is already active/staged.
5. **Terminal 1 staging geometry mismatch.** If the staging polygon does not include the physical test location, the status may not become staged. However this alone does not explain “You are here” unless center/radius or stale state set `currentZoneId`.
6. **Supabase/RLS/RPC failure prevented `driver_presence` write.** Less likely if status was passive, because heartbeat would already be blocked; still needs verification.

## 6. Recommended state-machine fix direction

Implement a single transition service in a follow-up phase. The service should be the only writer of:

- Redux `status/currentZoneId/isInsideZone/zoneEntryTime`.
- `drivers.status`.
- `drivers.current_zone_id`.
- `driver_presence` upsert/clear.
- background task start/stop decisions.

Until that exists, UI should explicitly detect mismatches: passive + currentZoneId, staged + no presence, currentZoneId + count 0, and stale heartbeat.
