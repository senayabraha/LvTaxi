# LV Taxi — Status Transition Helper

> Implementation note for `src/lib/driverStatusTransitions.js` (added to prevent
> divergence between driver status and zone state). Pairs with
> `driver-status-state-machine.md`.

## Why

Before this helper, a driver's status and zone were written from many places via
separate dispatches (`setStatus` + `setCurrentZone` / `zoneEntered`) plus a
separate Supabase write (`persistDriverStatus`). Those could interleave and leave
the app inconsistent — most visibly the field bug:

- `drivers.status = passive_far`
- `currentZoneId = Terminal 1`
- UI shows "You are here — Position #1"
- live count = 0

i.e. status said "not participating" while zone state still pointed at a queue.

## What

`src/lib/driverStatusTransitions.js` is a single, focused funnel. Every function:

1. Sets **all** related Redux fields in **one** dispatch
   (`setDriverParticipationState` in `src/store/driversSlice.js`) — `status`,
   `currentZoneId`, `isInsideZone`, `zoneEntryTime`, `workAreaExitStartedAt` —
   so they can never disagree.
2. Persists the matching `drivers` columns to Supabase **only when status/zone
   actually changed**, so no extra write is added per GPS tick.

It deliberately does **not** send presence heartbeats and does **not** start/stop
background tasks — those stay in `presenceHeartbeat.js` and
`backgroundTrackingService.js`. The helper imports only `store`, `driversSlice`,
`supabase`, and `constants`, so it introduces no import cycle.

### API

| Function | Redux result | Supabase write |
|---|---|---|
| `transitionToPassive(driverId, status, opts?)` | passive_far/near, zone null, isInsideZone false, zoneEntryTime null, exit-stamp null (unless `preserveExitGrace`) | only on change; `status`, `current_zone_id=null`, `work_area_exit_started_at=null`, optional `work_area_exit_time` |
| `transitionToActive(driverId, opts?)` | active, zone null, isInsideZone false | only on change; `status`, `current_zone_id=null`, `work_area_exit_started_at=null`, optional `work_area_entry_time` |
| `transitionToStaged(driverId, zoneId, opts?)` | staged, zone set, isInsideZone true, zoneEntryTime set (preserved if same zone) | on change or `force`; `status`, `current_zone_id=zoneId`, `work_area_exit_started_at=null`, `last_seen` |
| `transitionToExitGrace(driverId, opts?)` | exit_grace, zone null, isInsideZone false, exit-stamp set | only when first entering grace; `status`, `current_zone_id=null`, `work_area_exit_started_at` |
| `transitionToTrackingDisabled(driverId, reason, opts?)` | tracking_disabled, zone null, isInsideZone false | always; `status`, `current_zone_id=null`, optional `tracking_enabled=false`, `last_seen` |

Options: `transitionToStaged({ force, workAreaEntryTime })`,
`transitionToActive({ workAreaEntryTime })`,
`transitionToPassive({ preserveExitGrace, workAreaExitTime })`,
`transitionToExitGrace({ startedAt })`,
`transitionToTrackingDisabled(_, { trackingEnabled })`.

## Invariants enforced

- **passive_far / passive_near** — zone null, isInsideZone false, zoneEntryTime
  null, no heartbeat (this helper never heartbeats), exit-stamp null unless
  `preserveExitGrace`.
- **active** — zone null, isInsideZone false, exit-stamp null.
- **staged** — requires a `zoneId` (no-op + warning otherwise); zone set,
  isInsideZone true, zoneEntryTime set, exit-stamp null, `last_seen=now`.
- **exit_grace** — zone null, isInsideZone false, exit-stamp set, `last_seen=now`.
- **tracking_disabled** — zone null, isInsideZone false, `last_seen=now`,
  `tracking_enabled` flippable.

## Call sites updated

- `src/lib/backgroundTracking/passiveLocationTask.js` — auto-activate
  (→ `transitionToStaged`/`transitionToActive`) and FAR/NEAR reclassify
  (→ `transitionToPassive`).
- `src/lib/backgroundTracking/activeLocationTask.js` — inside-work-area
  active/staged switching (→ `transitionToStaged`/`transitionToActive`).
- `src/lib/backgroundTracking/exitGraceManager.js` — `startExitGrace` and the
  within-window branch of `evaluateExitGrace` (→ `transitionToExitGrace`);
  `completeExitToPassive` (→ `transitionToPassive`).
- `src/lib/backgroundTracking/backgroundTrackingService.js` —
  `reconcileTrackingOnAppLaunch` steps 1/2 (→ `transitionToTrackingDisabled`),
  inside-work-area (→ `transitionToActive`), passive branches
  (→ `transitionToPassive`); `disableTrackingFromUI`
  (→ `transitionToTrackingDisabled`).
- `src/components/ImStagingButton.jsx` — manual stage
  (→ `transitionToStaged(..., { force: true })`, then forced heartbeat).

## Call sites NOT yet updated (intentional, this step)

- `src/lib/geofenceEngine.js` `completeHandleEnter` — still uses
  `zoneEntered` + `persistDriverStatus(STAGED)`. It already promotes to STAGED
  *before* the forced heartbeat, so it is correct today; converting it touches the
  visit-insert/heartbeat ordering and is deferred to keep this step small.
- `backgroundTrackingService.reconcileTrackingOnAppLaunch` exit-grace branch
  (`safeDispatch(setStatus(EXIT_GRACE))`) — left as-is so it cannot accidentally
  re-stamp an in-flight grace window from cold Redux on launch.
- `persistDriverStatus` (in `backgroundTrackingService.js`) is retained and still
  used by `geofenceEngine.js`; not removed for backward compatibility.

## How this prevents passive + currentZoneId inconsistency

Status and zone now change together in one Redux dispatch, and passive/active/
disabled/exit-grace transitions all set `currentZoneId = null` explicitly. So the
prior failure mode — a passive status retaining a stale `currentZoneId` — can no
longer occur through any updated call site. A stale zone left by an older path is
also actively cleared on the next passive/active reconcile tick.

## Manual QA (no automated test setup in this repo)

Run `expo start` on a device/emulator (deps must be installed first) and verify:

1. **Reclassify is write-free.** Sit outside the work area; confirm FAR→FAR ticks
   don't write `drivers` every cycle (watch logs / Supabase), but a stale
   `current_zone_id` (if any) is cleared once.
2. **Auto-stage.** Enter a staging-zone polygon → status `staged`, `currentZoneId`
   set, `driver_presence` STAGING row fresh, zone count = 1.
3. **Leave zone (still in work area).** → status `active`, `currentZoneId` null.
4. **Leave work area.** → `exit_grace`, `currentZoneId` null, presence cleared,
   one Supabase write (not per-tick).
5. **Manual "I'm Staging".** → status `staged` + zone set + counted.
6. **Disable tracking / logout.** → `tracking_disabled`, zone null, presence
   cleared.
7. **Invariant check:** at no point should the UI show "You are here" while the
   top status is passive — status and zone always move together now.
