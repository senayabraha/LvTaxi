# LV Taxi — Architecture Map

> Analysis-only. Text diagrams + source-of-truth + ownership boundaries.

---

## 1. High-level module diagram

```
MOBILE APP (Expo / React Native)
├─ Auth / session        src/store/authSlice.js, src/lib/sessionManager.js, src/lib/supabase.js
├─ Profile               src/screens/ProfileScreen.jsx, src/screens/NameScreen.jsx
├─ Location permission   src/screens/LocationPermissionScreen.jsx
├─ Foreground GPS engine src/lib/locationEngine.js  (watchPositionAsync, smoothing, dispatch)
├─ Background tracking   src/lib/backgroundTracking/
│   ├─ service           backgroundTrackingService.js (start/stop, persistDriverStatus, reconcile)
│   ├─ passive task      passiveLocationTask.js  (~20m/5m cadence, upgrade detection)
│   ├─ active task       activeLocationTask.js   (5s cadence, zone/status changes)
│   ├─ exit grace        exitGraceManager.js     (timestamp-based 30-min grace)
│   ├─ task names        trackingTaskNames.js
│   └─ debug             trackingDebug.js
├─ Work-area geometry    src/lib/workAreaGeometry.js (inside polygon, distance, classify)
├─ Staging-zone geometry src/lib/geofenceEngine.js   (hybrid circle+polygon, visits)
├─ Native geofence mgr   src/lib/geofenceEngine.js   (Location.startGeofencingAsync)
├─ Presence heartbeat    src/lib/presenceHeartbeat.js (throttled upsert_driver_presence)
├─ Zone stats engine     src/lib/zoneStatsEngine.js  (fetchLiveZoneStats, upsertDriverPresence)
├─ Visit/trajectory      visitProcessor.js, visitReconciler.js, trajectoryRecorder.js,
│                        behavioralClassifier.js
├─ Notifications         notificationEngine.js, notificationService.js
├─ Offline retry         offlineRetryManager.js, offlineCache.js, offlineQueueDiagnostics.js
├─ Redux store           src/store/ (index.js, authSlice, driversSlice, zonesSlice)  ** NOT persisted **
└─ UI                    src/screens/*, src/components/*, src/hooks/useZones.js

SUPABASE
├─ Tables   drivers, driver_presence, staging_zones, work_areas, zone_stats, zone_visits,
│           zone_departures, trajectories, driver_zone_history, notifications,
│           reference_routes, zone_config_versions, zone_audit_log
├─ View     active_driver_presence (90s TTL + zone NOT NULL + classification in STAGING/UNKNOWN)
├─ RPC      get_zone_live_stats(), upsert_driver_presence(), clear_driver_presence(),
│           finalize_visit_classification(), increment/decrement_zone_count() [DEPRECATED],
│           soft_delete_driver(), cancel_account_deletion()
├─ RLS      per-table policies (see database-schema-analysis.md)
└─ Edge fns send-push, classify-trajectory, request/confirm/cancel/delete-account

ADMIN APP (Vite + React)
├─ Driver monitoring  admin/src/pages/DriversPage.jsx
├─ Zone builder       admin/src/builder/*, ZonesPage.jsx, ZoneTable.jsx, ZoneCard.jsx
├─ Zone health        admin/src/lib/zoneHealth.js
├─ System check       admin/src/pages/SystemCheckPage.jsx
├─ Live ops           admin/src/pages/LiveOpsPage.jsx
├─ Audit / versions   admin/src/pages/AuditPage.jsx, ZoneVersionsModal.jsx
├─ Announcements      admin/src/pages/AnnouncementsPage.jsx (→ send-push)
└─ QA tools           admin/scripts/smoke-zone-logic.mjs
```

---

## 2. Data-flow diagrams (text)

**Foreground GPS → Redux**
```
watchPositionAsync → locationEngine (smooth/Kalman) → dispatch(setLocation) → drivers.currentLat/Lng
                                                     → presenceHeartbeatFromLocation(point)
```

**GPS → background task → status decision → drivers table**
```
passive/active task → workAreaGeometry.isInsideWorkAreaPolygon? → geofenceEngine.detect zone
   → persistDriverStatus(driverId, status, {current_zone_id,...})
   → supabase update drivers.status + setStatus() into Redux
```

**GPS → heartbeat → driver_presence**
```
status in {active,staged} → maybeSendPresenceHeartbeat (throttle 25s)
   → upsert_driver_presence RPC → driver_presence row (last_ping_at, current_zone_id, classification)
```

**driver_presence → live count → UI**
```
driver_presence → active_driver_presence view (90s TTL) → get_zone_live_stats() RPC
   → useZones.fetchLiveZoneStats → dispatch(updateZoneStat) → zones.stats[zoneId]
   → ZoneListItem (cars_staged, wait range, freshness)
```

**Zone visit → departures → wait/flow**
```
geofence Enter → zone_visits insert → (dwell while staged) → geofence Exit → zone_visits update
   → processZoneExit → behavioralClassifier → finalize_visit_classification (classification, trajectory)
   → zone_departures feeds smoothed_rate; zone_visits feeds median dwell
```

**Admin edits → geometry → mobile detection**
```
admin ZonesPage/builder → staging_zones / work_areas (RLS: is_admin)
   → mobile useZones fetch + offlineCache → geofenceEngine geometry / workAreaGeometry
```

---

## 3. Source-of-truth table

| Concept | Source of truth | Notes |
|---|---|---|
| Driver identity | `drivers` (PK = `auth.users.id`) | |
| Current driver status | `drivers.status` (DB), mirrored in Redux `drivers.status` | written from many places (see ownership) |
| Current zone | `driver_presence.current_zone_id` for counting; Redux `currentZoneId` for UI | **these can diverge** — root of the "You are here" bug |
| Live queue count | `active_driver_presence` → `get_zone_live_stats().cars_staged` | NOT `zone_stats.cars_staged` (legacy cache) |
| Wait estimate | `get_zone_live_stats()` (blended) | `zone_stats` columns are display cache |
| Zone geometry | `staging_zones` polygons/circle | |
| Work-area geometry | `work_areas.polygon` (active) | |
| Online/stale/offline (admin) | `driver_presence.last_ping_at` thresholds | DriversPage uses 90s/30min |
| Notification eligibility | `notifications` + cooldown tables; status filter in `send-push` | |

---

## 4. Ownership boundaries (intended vs. violated)

| Responsibility | Should be owned by | Reality |
|---|---|---|
| Status transitions | One central state machine | **VIOLATED** — written in ≥11 sites (UI, geofence, passive/active tasks, exit grace, reconcile) |
| GPS acquisition | locationEngine (fg) + background tasks (bg) | OK |
| Geofence wake-up | geofenceEngine | OK |
| Polygon verification | workAreaGeometry (work) + geofenceEngine (zone) | OK |
| Presence writes | presenceHeartbeat → zoneStatsEngine.upsertDriverPresence | OK (single funnel) but gated by status set elsewhere |
| Count calculation | `get_zone_live_stats()` RPC | OK (DB-authoritative) |
| Wait-time calculation | `get_zone_live_stats()` RPC | OK |
| UI display | components reading Redux/RPC | **partial violation** — `currentZoneId` (Redux) and presence (DB) read independently, can contradict |

**Primary architectural smell:** there is no single owner of status. `currentZoneId` (Redux,
set by `zoneEntered`/`setCurrentZone`) and `driver_presence.current_zone_id` (DB, set by heartbeat)
are independent, and the UI's "You are here" reads the former while the count reads the latter.
This is the structural cause of the contradictions in the Samsung case study.
