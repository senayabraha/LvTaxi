# Status Transition Helper

This document describes the shared driver-status transition helpers used by the automatic tracking system.

## `transitionToStaged(driverId, zoneId, opts)`

Use this helper when a path has confirmed that the driver is physically inside a staging-zone polygon and must become counted as staged.

It writes local Redux first:

- `drivers.status = staged`
- `drivers.currentZoneId = zoneId`
- `drivers.isInsideZone = true`
- `drivers.zoneEntryTime = now`
- `drivers.workAreaExitStartedAt = null`

It then persists the `drivers` row:

- `status = staged`
- `current_zone_id = zoneId`
- `work_area_exit_started_at = null`
- `last_seen = now`

## Geofence confirmed entry path

`geofenceEngine.completeHandleEnter(zoneId, zone, driverId)` is the confirmed-entry path after native geofence wake-up and polygon verification. Geofence entry must promote the driver to `STAGED` before calling `maybeSendPresenceHeartbeat()`.

That order matters because `maybeSendPresenceHeartbeat()` intentionally refuses writes unless Redux status is heartbeat-eligible (`active` or `staged`). If the phone is physically in Terminal 1 staging but Redux is still `passive_far`, even `force: true` is blocked. The result is the broken state where local zone UI can show "You are here" while live queue math still shows `0 car`.

The confirmed-entry order is:

1. Set the `activeVisits` sentinel to prevent duplicate enter handling.
2. Insert `zone_visits` and capture `visitId` when available.
3. Call `transitionToStaged(driverId, zoneId)`.
4. Send a forced `driver_presence` heartbeat with `classification = STAGING`.
5. Start trajectory recording for the visit.

The forced heartbeat includes `driverId`, `zoneId`, `classification`, `lat`, `lng`, `speed`, `accuracy`, `heading`, `visitId`, and `force = true`.

This fixes "You are here but 0 car" because the app now writes all three pieces required for the live count pipeline:

- Redux status/current zone match the confirmed staging-zone entry.
- `drivers.status` and `drivers.current_zone_id` are persisted.
- `driver_presence.current_zone_id`, `classification = STAGING`, and fresh `last_ping_at` are written after the status promotion, so `active_driver_presence` and `get_zone_live_stats()` can count the driver.
