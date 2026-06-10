# LV Taxi Architecture Map

Analysis-only documentation. No implementation changes are made here.

## 1. High-level module diagram

```text
Mobile App
├─ App.jsx
│  ├─ imports passiveLocationTask and activeLocationTask at module scope
│  ├─ starts session listener
│  ├─ starts tier manager
│  ├─ reconciles background tracking on launch
│  └─ starts offline retry manager
├─ Auth/session
│  ├─ sessionManager
│  └─ Redux auth state
├─ Profile
│  ├─ drivers profile row
│  └─ tracking_enabled/status hydration
├─ Location permission
│  ├─ LocationPermissionScreen
│  ├─ foreground permission
│  └─ background permission
├─ Foreground location engine
│  ├─ locationEngine.js
│  ├─ watchPositionAsync
│  ├─ Kalman smoothing
│  ├─ Redux setLocation
│  └─ foreground heartbeat attempt
├─ Background tracking service
│  ├─ backgroundTrackingService.js
│  ├─ start/stop passive task
│  ├─ start/stop active task
│  ├─ persistDriverStatus
│  └─ reconcileTrackingOnAppLaunch
├─ Passive background task
│  ├─ passiveLocationTask.js
│  ├─ outside work-area monitoring
│  ├─ passive_far/passive_near
│  └─ upgrades to active/staged
├─ Active background task
│  ├─ activeLocationTask.js
│  ├─ work-area check
│  ├─ staging-zone check
│  ├─ active/staged transitions
│  └─ presence heartbeat
├─ Exit grace manager
│  ├─ timestamp-based grace
│  ├─ clears presence
│  └─ re-entry/expiry transitions
├─ Work-area geometry
│  ├─ workAreaGeometry.js
│  ├─ work_areas cache
│  ├─ staging_zones cache
│  └─ polygon source of truth
├─ Native geofence manager
│  ├─ geofenceEngine.js
│  ├─ top-20 zones
│  ├─ native circular geofences
│  └─ polygon verification on enter
├─ Presence heartbeat
│  ├─ presenceHeartbeat.js
│  ├─ isHeartbeatStatus guard
│  └─ upsertDriverPresence RPC
├─ Zone stats engine
│  ├─ fetchLiveZoneStats RPC
│  ├─ clearDriverPresence RPC
│  └─ legacy counters retained but deprecated
├─ Visit/trajectory processing
│  ├─ zone_visits
│  ├─ trajectoryRecorder
│  ├─ visitProcessor
│  └─ visitReconciler
├─ Notification engine
│  ├─ notificationEngine
│  └─ notificationService
├─ Offline retry
│  └─ offlineRetryManager
├─ Redux store
│  ├─ driversSlice
│  └─ zonesSlice
└─ UI
   ├─ HomeScreen
   ├─ AutoStatusBar
   ├─ ZoneListItem
   ├─ ImStagingButton
   ├─ TrackingDebugPanel
   └─ Profile/permission screens

Supabase
├─ drivers
├─ driver_presence
├─ active_driver_presence view
├─ staging_zones
├─ work_areas
├─ zone_visits
├─ zone_departures
├─ zone_stats
├─ trajectories
├─ driver_zone_history
├─ notifications
├─ RPCs
│  ├─ get_zone_live_stats
│  ├─ upsert_driver_presence
│  ├─ clear_driver_presence
│  ├─ increment_zone_count/decrement_zone_count legacy
│  └─ record_load_event
├─ RLS policies
└─ Edge functions, if present

Admin App
├─ Driver monitoring
├─ Zones/zone builder
├─ Zone health
├─ System check
├─ Audit logs
└─ QA/testing docs
```

## 2. Data-flow diagrams

### GPS to Redux

```text
Location.watchPositionAsync
-> locationEngine.handleLocationUpdate
-> Kalman smoothing
-> Redux drivers.setLocation
-> HomeScreen / geofence top-20 / AutoStatusBar / ZoneListItem
```

### GPS to status decision

```text
Expo TaskManager location update
-> passiveLocationTask or activeLocationTask
-> refreshWorkAreaCache
-> isInsideWorkAreaPolygon
-> detectStagingZoneFromPoint
-> persistDriverStatus
-> drivers table + Redux status/currentZoneId
```

### GPS to presence heartbeat

```text
active/staged GPS fix
-> maybeSendPresenceHeartbeat
-> isHeartbeatStatus guard
-> upsertDriverPresence RPC
-> driver_presence row
-> active_driver_presence TTL view
```

### Live count to mobile UI

```text
driver_presence
-> active_driver_presence 90-second TTL + zone + classification filter
-> get_zone_live_stats
-> zoneStatsEngine.fetchLiveZoneStats
-> useZones
-> Redux zones.stats
-> ZoneListItem cars_staged
```

### Visit/departure to wait estimate

```text
zone enter/exit
-> zone_visits
-> visit classification
-> zone_departures / completed STAGING visits
-> get_zone_live_stats smoothed service rate + median dwell
-> wait estimate/range/confidence/status
```

### Admin edits to mobile detection

```text
admin zone/work-area edit
-> staging_zones/work_areas
-> mobile useZones / workAreaGeometry cache / tierManager cache
-> background detection + native geofence registration
```

## 3. Source-of-truth table

| Concept | Source of truth | Notes |
|---|---|---|
| Driver identity | Supabase Auth user id + `drivers.id` | `drivers.id` may have auth FK removed by migration 007, but logically matches auth user. |
| Driver profile | `drivers` | Hydrated into Redux by profile/session flow. |
| Current driver status | `drivers.status` cross-launch; Redux in-memory during session | Risk: multiple modules can set status. |
| Current zone | `drivers.current_zone_id` + Redux `currentZoneId`; live count uses `driver_presence.current_zone_id` | These can diverge. |
| Live queue count | `driver_presence` filtered by TTL/class/zone via `get_zone_live_stats` | `zone_stats.cars_staged` is legacy/cache only. |
| Wait estimate | `get_zone_live_stats` derived fields | Uses `zone_departures` + `zone_visits`. |
| Zone geometry | `staging_zones.drawn_polygon/driven_polygon` | `use_driven_polygon` chooses geometry. |
| Work-area geometry | `work_areas.polygon` | Required for automatic active/staged eligibility. |
| Online/stale/offline admin state | `driver_presence.last_ping_at` age | Admin reads raw presence and applies 90s/30m windows. |
| Notification eligibility | Redux status + zone proximity + notification engine | Should be active-participation only. |

## 4. Ownership boundaries

| Responsibility | Should be owned by | Current concern |
|---|---|---|
| Status transitions | One centralized state-machine module | Currently spread across background tasks, geofenceEngine, ImStagingButton, background service, driversSlice, and legacy/tier paths. |
| GPS acquisition | locationEngine foreground and backgroundTrackingService background | Two mechanisms run: foreground watcher and background tasks. This is acceptable if ownership is explicit. |
| Geofence wake-up | geofenceEngine native circles | Should wake only; should not be authoritative unless it calls same central state transition. |
| Polygon verification | workAreaGeometry | tierManager duplicates some geometry logic. |
| Presence writes | presenceHeartbeat + zoneStatsEngine RPC wrapper | Correct guard exists, but it can suppress writes when status is stale/passive. |
| Count calculation | `get_zone_live_stats` | Correct source of truth; UI may display contradictory local current-zone state. |
| Wait-time calculation | `get_zone_live_stats` and visit/departure pipeline | Needs diagnostics and sample thresholds. |
| UI display | Screens/components only | UI currently treats local `currentZoneId` as “You are here” even if presence/count disagrees. |

## 5. Ownership violations / overlap

1. `tierManager.js` controls GPS tier independently from the automatic background status machine.
2. `geofenceEngine.js` can set `zoneEntered` and status via `persistDriverStatus`; this overlaps active/passive background task detection.
3. `ImStagingButton.jsx` manually sets status/current zone/presence and updates `drivers`, bypassing a central state transition API.
4. `driversSlice` contains generic reducers (`zoneEntered`, `setCurrentZone`) that can set zone state without ensuring status/presence consistency.
5. Admin driver status summary mixes `drivers.status` and presence classification, which can exaggerate staged counts if the two disagree.

## 6. Architecture recommendation

The target architecture should introduce one driver-state transition service with operations such as:

- `enterPassiveFar(reason, gps)`
- `enterPassiveNear(reason, gps)`
- `enterActive(reason, gps)`
- `enterStaged(zoneId, reason, gps)`
- `enterExitGrace(reason, gps)`
- `enterTrackingDisabled(reason)`

Every path—background task, native geofence callback, manual staging button, launch reconciliation, and permission/logout—should call this service. That service should atomically update Redux, `drivers`, and `driver_presence` according to the status contract.
