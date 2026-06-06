# LV Taxi — System Behavior Spec

> **Status:** Analysis-only. Describes how the system is *intended* to behave and how the
> current code actually behaves, with file references. No code changes are proposed here;
> see `fix-roadmap.md` for remediation.

---

## 1. Product goal

**Plain English.** LV Taxi is a phone app for Las Vegas taxi drivers. A driver installs it,
grants location access, and then *does nothing else* — the app figures out on its own whether
the driver is far from the work area, near it, inside it, sitting in a staging queue (e.g. an
airport terminal lane or a hotel cab line), leaving the area, or not tracking. By aggregating
where all drivers are, the app shows everyone a **live count of cars in each staging zone**,
how fast the line is moving (**flow**), and an **estimated wait**. The aim is to help drivers
decide where to go without manually checking in.

**Technically.** The app is an Expo / React Native client backed by Supabase (Postgres + RLS +
RPC + Edge Functions) and a Vite/React admin dashboard. The client runs a GPS-driven state
machine that classifies the driver into one of seven statuses, writes a lightweight
**presence heartbeat** to `driver_presence` while on duty, and reads aggregated per-zone stats
from the `get_zone_live_stats()` RPC. Live counts are derived **only** from fresh presence rows
(90-second TTL) via the `active_driver_presence` view — never from driver-reported status alone.

Core constants live in `src/lib/constants.js`. The single staleness window for the whole system
is `PRESENCE_TTL_SECONDS = 90` (`constants.js:148`).

---

## 2. Driver lifecycle (expected)

| Stage | What happens | Intended status |
|---|---|---|
| App installed | No permission yet, no tracking | `tracking_disabled` |
| Permission granted | App-launch reconciliation runs (`backgroundTrackingService.reconcileTrackingOnAppLaunch`) | computed from position |
| Outside work area, far | >3 km from work-area polygon boundary | `passive_far` (~20 min GPS) |
| Near work area | ≤3 km from boundary (`PASSIVE_NEAR_THRESHOLD_METERS`, `constants.js:222`) | `passive_near` (~5 min GPS) |
| Enters work-area polygon | Auto-upgrade, active GPS + heartbeat begins | `active` |
| Enters staging-zone polygon | Counted in that zone's queue | `staged` |
| Leaves staging zone (still in work area) | Drops zone, still on duty | `active` |
| Leaves work area | 30-min timestamp-based grace begins | `exit_grace` |
| Returns within grace | Re-enter cancels grace | `active`/`staged` |
| Grace expires (30 min) | Presence cleared, back to passive | `passive_far`/`passive_near` |
| Logout / permission revoked / account inactive / user toggle | Tracking fully off | `tracking_disabled` |

Timing constants: `PASSIVE_FAR_INTERVAL_MS` 20 min, `PASSIVE_NEAR_INTERVAL_MS` 5 min,
`ACTIVE_LOCATION_INTERVAL_MS` 5 s, `EXIT_GRACE_LOCATION_INTERVAL_MS` 60 s,
`WORK_AREA_EXIT_GRACE_MS` 30 min (`constants.js:209-217`).

---

## 3. Driver statuses (authoritative table)

Source of truth for the enum: `DRIVER_STATUS` in `constants.js:194`. Predicates that interpret
it: `isPassiveStatus`, `isHeartbeatStatus`, `isActiveParticipationStatus`, `countsInStagingMath`
(`constants.js:231-258`).

| Status | Meaning | GPS task | Heartbeats? | Counts in queue? | `current_zone_id` | Mobile UI (AutoStatusBar) | Admin (DriversPage) |
|---|---|---|---|---|---|---|---|
| `tracking_disabled` | Logout / no permission / inactive / user-off | none | no | no | null | 🔴 "Tracking off" | offline |
| `passive_far` | Outside work area, far | passive ~20 min | **no** | **no** | null | ⚪ "Passive (far)" | offline (no fresh ping) |
| `passive_near` | Outside work area, near | passive ~5 min | **no** | **no** | null | 🔵 "Passive (near)" | offline |
| `active` | Inside work area, no zone | active 5 s | **yes** (zone=null) | **no** (null zone) | null | 🟢 "Active" | online |
| `staged` | Inside a staging-zone polygon | active 5 s | **yes** (zone set) | **yes** | zone id | 🟡 "Staging [zone]" | online + staged |
| `exit_grace` | Just left work area, 30-min grace | light 60 s | **no** (cleared) | **no** | should be null | 🟠 "Leaving area" | stale→offline |
| `off_duty` (legacy) | Backward-compat only | none | no | no | null | 🔴 "Off Duty" | offline |

Key rule, enforced in `constants.js`: **only `active`/`staged` heartbeat** (`isHeartbeatStatus`),
and **only `staged` counts** in staging math (`countsInStagingMath`). Passive and exit-grace must
never write presence.

---

## 4. Queue-count rules

A driver counts as "1 car" in a zone **iff all of these hold** (enforced by
`active_driver_presence` view + `get_zone_live_stats()` `live_counts` CTE,
`012_secure_presence_and_live_stats_fix.sql:130-139`):

1. A `driver_presence` row exists for the driver.
2. `last_ping_at > now() - interval '90 seconds'` (the TTL; mirrors `PRESENCE_TTL_SECONDS`).
3. `current_zone_id IS NOT NULL`.
4. `classification IN ('STAGING','UNKNOWN')` — `PASSING`, `DROP_OFF`, `ACTIVE`, `EXIT_GRACE`
   are **excluded**.

Note `drivers.status` is **not** read by the count query. Status matters only *indirectly*:
the heartbeat guard (`presenceHeartbeat.js:46`) refuses to write presence unless status is
`active`/`staged`, so status gates whether a counting row ever appears.

---

## 5. Work-area rules

- The **work-area polygon** (`work_areas` table, migration `010_work_areas.sql`) is the source of
  truth for "working vs passive". Distance/inside tests live in `src/lib/workAreaGeometry.js`
  (`classifyPassiveDistance`, `isInsideWorkAreaPolygon`).
- A driver can only auto-upgrade to `active`/`staged` while **inside an active work-area polygon**
  (`passiveLocationTask.js`, `activeLocationTask.js`).
- **Failure behavior (current).** If the work-area polygon cannot load (no active row, empty cache,
  malformed polygon), `isInsideWorkAreaPolygon` returns false and the driver is treated as
  *outside* → kept passive → no heartbeat → not counted. This is a **fail-closed** behavior that
  is a leading suspect in the Samsung Terminal 1 bug (see §`driver-status-state-machine.md`).

---

## 6. Staging-zone rules

- The **staging-zone polygon** (`staging_zones` table) detects the exact queue. Geometry fields:
  `drawn_polygon`, `driven_polygon`, `use_driven_polygon`, plus `lat`/`lng`/`radius_meters` and
  `circle_enabled` for the native geofence circle.
- Detection is **hybrid**: a native geofence *circle* wakes the app (`geofenceEngine.applyGeofences`),
  then the polygon refines it (`verifyWithPolygon`, `geofenceEngine.js:41`). **If no polygon is
  present, the circle is trusted** (`verifyWithPolygon` returns true).
- `is_coming_soon` zones are placeholders and must **never** count or consume a geofence slot
  (`getTop20Zones` filters them, `geofenceEngine.js:283`).
- `active = false` zones are excluded from the mobile zone list (`useZones` filters `active=true` +
  `visible_to_drivers=true`) and from `get_zone_live_stats` (`...:212 WHERE sz.active = true`).

---

## 7. Android / iOS behavior (intended vs. risk)

| Condition | Intended | Risk / reality |
|---|---|---|
| Foreground | Full GPS + heartbeat | Works |
| Background | Foreground-service keeps active/passive tasks alive | Configured (`backgroundTrackingService.js:121-147`) |
| Locked screen | Active task continues via foreground service | Generally OK on Android with FGS |
| App relaunched | `reconcileTrackingOnAppLaunch` recomputes status | OK if work-area loads |
| App killed/swiped | OS may stop tasks; geofence may still wake | Geofence less reliable; presence stops |
| Battery saver | OS may throttle/kill background work | **No battery-optimization exemption requested** — Samsung Knox especially aggressive |
| Permission revoked | Reconcile → `tracking_disabled` | OK |

See `gps-background-tracking-analysis.md` for detail.

---

## 8. Failure behavior (safe-state expectations)

| Failure | Current behavior | Safe? |
|---|---|---|
| No GPS fix | No location dispatched; status unchanged | Acceptable, but no user signal |
| Stale GPS | `getLastKnownPositionAsync` maxAge guards (30 s/15 s) | Acceptable |
| Bad accuracy | Kalman/locationEngine smoothing; geofence still circle-based | Partial |
| No work-area polygon | Treated as outside → passive → not counted | **Fail-closed but silently wrong** |
| No staging-zone polygon | Circle trusted (`verifyWithPolygon` true) | Fail-open (may over-count) |
| No Supabase connection | Offline cache + `offlineRetryManager` queue | Acceptable |
| Stale `driver_presence` | TTL drops driver from counts after 90 s | Correct |
| App background limits | Tasks may not run | **No surfaced warning to driver** |

Cross-references: `live-queue-count-analysis.md`, `gps-background-tracking-analysis.md`,
`geofence-zone-model-analysis.md`, `system-risk-register.md`.
