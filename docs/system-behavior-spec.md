# LV Taxi System Behavior Spec

Analysis-only documentation. This file describes expected behavior and known implementation contracts. It does not implement fixes.

## 1. Product goal

LV Taxi is intended to help Las Vegas taxi drivers understand staging demand and queue movement without manually reporting their position. A driver installs the app, grants location permission, and the app automatically classifies the driver as outside the work area, near the work area, active inside the work area, staged inside a queue, leaving the work area, or tracking-disabled.

Technically, the product depends on a reliable chain:

```text
GPS fix -> work-area polygon check -> staging-zone polygon check -> driver status/current_zone_id -> driver_presence heartbeat -> active_driver_presence TTL view -> get_zone_live_stats() -> mobile/admin UI
```

The app must avoid counting a driver unless the system has positive, fresh evidence that the driver is inside a valid staging zone.

## 2. Expected driver lifecycle

1. App installed.
2. User signs in and a `drivers` row exists.
3. Location permission is requested. Foreground permission is required; background permission is required for reliable background behavior.
4. If tracking is disabled, permission is missing, user logs out, or account is inactive, status is `tracking_disabled` and no live presence should count.
5. If the driver is outside the work area, status should be either `passive_far` or `passive_near` depending on distance from the nearest active work-area polygon.
6. If the driver enters an active work-area polygon, status should become `active` unless a staging-zone polygon also contains the driver.
7. If the driver enters a valid active staging-zone polygon, status should become `staged`, `drivers.current_zone_id` should be set, and a fresh `driver_presence` heartbeat should be written with `classification = STAGING`.
8. If the driver leaves the staging zone but remains in the work area, status should become `active`, `current_zone_id` should become null, and presence should remain fresh but uncounted.
9. If the driver leaves the work area, status should become `exit_grace`, `current_zone_id` should clear, and live presence should be cleared immediately.
10. If the driver re-enters during grace, status should return to `active` or `staged` based on polygons.
11. If grace expires outside the work area, status should become `passive_near` or `passive_far`.
12. If tracking is disabled, logout occurs, or permission is revoked, status should become `tracking_disabled`, background tasks should stop, and live presence should clear.

## 3. Driver statuses

| Status | Meaning | GPS task | Presence heartbeat | Queue count | `current_zone_id` | Mobile UI | Admin UI |
|---|---|---|---|---|---|---|---|
| `tracking_disabled` | Tracking cannot or should not run. | None | No | No | Null | Tracking off | Offline/disabled |
| `passive_far` | Outside work area, far from boundary. | Passive slow background task | No | No | Null | Passive (far) | Passive/offline-like |
| `passive_near` | Outside work area, near boundary. | Passive faster background task | No | No | Null | Passive (near) | Passive/near |
| `active` | Inside work area but not in staging queue. | Active background task | Yes, `ACTIVE` and null zone | No | Null | Active | Online/active |
| `staged` | Inside staging-zone polygon. | Active background task | Yes, `STAGING` and zone id | Yes while fresh | Set to staging zone | Staging at zone | Online/staged |
| `exit_grace` | Recently left work area. | Active task at light cadence | No; presence cleared | No | Null | Leaving area | Leaving/grace |
| `off_duty` | Legacy compatibility value. | Should not be used for new state machine | No | No | Null | Off Duty fallback | Legacy/offline |

The code defines these statuses in `src/lib/constants.js`. The key predicates are: passive statuses do not heartbeat, only `active` and `staged` heartbeat, and only `staged` should count in staging math.

## 4. Queue-count rules

A driver should count as one car only when all of the following are true:

- The driver is actually inside a valid staging-zone polygon or accepted fallback for a polygon-less zone.
- `drivers.status = 'staged'`.
- `drivers.current_zone_id` is the zone id.
- `driver_presence.current_zone_id` is the same zone id.
- `driver_presence.classification IN ('STAGING', 'UNKNOWN')`.
- `driver_presence.last_ping_at > now() - interval '90 seconds'`.
- The zone is active and visible to drivers.

The documented TTL is 90 seconds. Heartbeats are designed around a 25-second interval, giving several chances to refresh before the TTL expires.

## 5. Work-area rules

The `work_areas` table is the source of truth for whether a driver may be considered working. Native circles and center/radius checks must not make a driver active unless the driver is inside an active work-area polygon.

Expected behavior if work areas cannot load: fail safe to outside/passive. This prevents false online/staged counts, but it can produce the real-world failure where a driver physically inside Terminal 1 remains `passive_far` if the work-area cache is empty, stale, inactive, malformed, or unreachable.

## 6. Staging-zone rules

A staging zone is the exact queue/staging area. Detection should prefer polygon geometry:

1. `driven_polygon` if `use_driven_polygon = true`.
2. Otherwise `drawn_polygon`.
3. Fallback center/radius should be allowed only for zones without polygons, not for overriding a failed polygon check.
4. `is_coming_soon = true` zones must not count.
5. `active = false` zones must not count or register geofences.

`drawn_polygon` should represent an admin-drawn geometry. `driven_polygon` should represent a path/shape captured from real driving. The system should make this distinction explicit in admin QA.

## 7. Android/iOS behavior

### Foreground

Foreground `watchPositionAsync` should update Redux location, support smooth UI, and invoke throttled presence heartbeat only when status is heartbeat-eligible.

### Background / locked screen

Expo background location tasks should run with foreground-service notification on Android. The active task is responsible for active/staged/exit-grace transitions and heartbeat. Passive task is responsible for detecting work-area entry and upgrading to active/staged.

### Relaunch

On launch, `reconcileTrackingOnAppLaunch()` should read permission, tracking flag, persisted status, work-area cache, and current GPS position, then start the correct task.

### App killed / swiped away

No design should promise reliable tracking after user force-closes the app. The app should recover on next launch and make this limitation clear in QA.

### Battery saver / Samsung optimization

Samsung battery restrictions can delay or stop background tasks. The app should surface diagnostic state and user instructions for battery optimization exclusions.

### Permission revoked

Status must become `tracking_disabled`, background tasks must stop, and presence must clear.

## 8. Failure behavior

| Failure | Safe behavior | User/admin message needed |
|---|---|---|
| No GPS fix | Do not auto-stage; keep/enter passive unless last trusted state is recent. | Waiting for GPS fix; show last fix age. |
| Stale GPS | Do not count. | GPS stale. |
| Bad accuracy | Avoid staging if accuracy exceeds threshold. | Accuracy too low; move into open sky. |
| No work-area polygon | Fail safe to passive. | Work area unavailable; cannot go active. |
| No staging polygon | Use small fallback only if zone truly polygon-less. | Zone geometry incomplete. |
| No Supabase connection | Keep local status but mark presence unconfirmed; retry writes. | Offline; live count may not include you. |
| Stale `driver_presence` | Remove from live counts after 90s. | Data stale / not counted. |
| Background task delayed | UI/admin should show last task run and heartbeat age. | Background tracking delayed. |

## Samsung Terminal 1 expected behavior

For the reported Samsung test inside Terminal 1 staging, the expected state is:

- `drivers.status = 'staged'`.
- `drivers.current_zone_id = Terminal 1 zone id`.
- `driver_presence.current_zone_id = Terminal 1 zone id`.
- `driver_presence.classification = 'STAGING'`.
- `driver_presence.last_ping_at` is within 90 seconds.
- `get_zone_live_stats()` returns `cars_staged = 1` for Terminal 1.
- Mobile card shows `1 car`, no stale warning, and the staging button does not say “Go online first.”
