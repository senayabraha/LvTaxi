# UI State Consistency Analysis

Analysis-only documentation. No UI code changes are made here.

## 1. Main UI state sources

| UI state | Source |
|---|---|
| Top driver status | Redux `drivers.status` |
| Current zone highlight | Redux `drivers.currentZoneId` |
| Zone count | `zones.stats[zone.id].cars_staged` from `get_zone_live_stats()` |
| Wait status | `zones.stats` enriched RPC fields |
| Fresh/stale label | `stat.last_updated` / `stat.updated_at` |
| Driver position | open `zone_visits` entered before local `zoneEntryTime` |
| Admin online/stale/offline | raw `driver_presence.last_ping_at` age |
| Admin status | `drivers.status` plus presence data |

The primary UI risk is that these sources are not a single atomic state. A local Redux zone can disagree with live presence and database status.

## 2. Component analysis

### `AutoStatusBar.jsx`

Displays:

- Status label from Redux `drivers.status`.
- Zone name only when status is `staged` and `currentZoneId` exists.
- GPS tier label from Redux `drivers.gpsTier`.

Risks:

- If `currentZoneId` exists while status is passive, AutoStatusBar correctly shows passive and hides zone, but ZoneListItem can still show “You are here.”
- GPS tier can be controlled by `tierManager`, which does not necessarily mean status is active/staged.

### `StatusToggle.jsx`

Not fully inspected in this pass. It should be checked for direct writes to `drivers.status` or legacy assumptions.

### `DriverToggle.jsx`

Displays a manual Driving/Off toggle. It writes `off_duty` and `active` directly, starts foreground location tracking, starts geofence manager, and clears presence when turning off.

Risks:

- Conflicts with automatic state machine.
- Persists legacy `off_duty`.
- Can set `active` without work-area polygon proof.
- Should likely be removed from production UI or replaced with tracking enable/disable only.

### `ImStagingButton.jsx`

Displays a floating “I’m Staging” action.

Reads:

- Redux `drivers.status`.
- Redux current GPS.
- Supabase `staging_zones` active/non-coming-soon list.

Behavior:

- Enabled only when status is `active` or `staged`.
- If not enabled, shows “Go online first to use staging.”
- Finds nearby zones by 200m center distance.
- On confirm, dispatches `staged` and `zoneEntered`, sends forced presence heartbeat, then updates `drivers`.

Risks:

- A driver physically in staging but status passive cannot use it.
- Nearby center/radius picker can select a zone without polygon verification.
- Writes are not atomic: Redux, presence RPC, and drivers update can partially fail.
- Does not explain why staging is disabled: outside work area, missing work area, no GPS, permission, stale status, etc.

### `ZoneListItem.jsx`

Displays:

- `cars_staged`.
- `flow_rate_per_hour`.
- wait label.
- confidence.
- freshness.
- “You are here” if `isCurrentZone` prop is true.

Risks:

- `isCurrentZone` comes from local Redux currentZoneId only.
- It does not require status `staged`.
- It does not require live presence eligibility.
- It can show “You are here” while count is 0 and status is passive.

### `HomeScreen.jsx`

Displays:

- AutoStatusBar.
- ConnectionBanner.
- sorted zone list.
- ImStagingButton.

Reads:

- Redux status/current location/current zone.
- `useZones()` for zones and stats.
- `zone_visits` through `getDriverPositionInZone`.

Risks:

- Current zone highlight is independent of backend live count.
- Driver position is based on open visits and local `zoneEntryTime`; it can say Position #1 when live presence is missing.
- Starts geofence manager regardless of status, while notifications are gated by active participation.

### `ProfileScreen.jsx`

Not deeply inspected in this pass. It should be checked for status display, tracking toggles, and profile status mismatch.

### `TrackingDebugPanel.jsx`

Not deeply inspected in this pass. It should become the main field-debug tool and include task/status/presence/geometry information.

### Admin `DriversPage.jsx`

Displays:

- Driver list from `drivers`.
- Presence map from `driver_presence`.
- Zone names from `staging_zones`.
- Online/stale/offline based on presence age.
- Staged summary if `driver.status === 'staged'` or `presence.classification === 'STAGING'`.

Risks:

- Admin staged summary can count a driver as staged based on driver status even if presence is stale/missing, or based on presence classification even if drivers status disagrees.
- Zone display uses `p.current_zone_id ?? d.current_zone_id`, which can hide disagreement.
- Needs explicit mismatch columns.

### Admin `SystemCheckPage`, `ZonesPage`, `zoneHealth`

Not deeply inspected in this pass. Should include work-area, zone geometry, active test zone, count pipeline, and RPC checks.

## 3. Contradiction analysis

| Contradiction | How it can happen | Recommended UI rule |
|---|---|---|
| Top status Passive while zone card says You are here | `currentZoneId` exists while `status` remains passive. | Show “GPS zone remembered; not active/not counted” or suppress current-zone highlight unless status/presence agree. |
| You are here but count is 0 | Local Redux zone but no live presence row. | Show “Not counted yet — heartbeat missing/stale.” |
| Staged status but no current zone | Bad transition or partial DB/Redux update. | Show warning and clear/reconcile. |
| Current zone but status active/passive | Generic zone setter without status transition. | Treat as mismatch, not staged. |
| Admin says online but mobile says passive | Presence row still fresh while mobile status changed or stale Redux. | Admin should show both status and presence eligibility. |
| Data stale while driver heartbeating | UI using cached stats or RPC not polling. | Show live stats source and last RPC success. |
| I’m Staging disabled though driver is physically staging | Status is passive due to work-area/GPS/task failure. | Explain disabled reason: “Not active because work area not detected.” |
| Profile status differs from Home | Profile uses persisted row while Home uses Redux. | Show source and last sync time. |
| Zone card highlight from stale Redux | `currentZoneId` not cleared on exit/logout/reconcile. | Clear zone on passive/disabled and verify against presence. |
| Old DriverToggle conflicts with read-only status design | Manual toggle writes legacy statuses. | Remove from production or convert to tracking enable/disable. |

## 4. Recommended UI consistency rules

1. Do not label “You are here” as a counted queue state unless:
   - `status === 'staged'`,
   - Redux `currentZoneId` matches card zone,
   - live `driver_presence` for this driver is fresh and matches zone/classification.
2. Add a distinct label for local GPS detection: “GPS detects you near/in this zone.”
3. Add “Not counted yet” state when local zone exists but presence is missing or stale.
4. Add a disabled reason under the I’m Staging button:
   - no GPS,
   - passive outside work area,
   - work area unavailable,
   - permission missing,
   - offline,
   - tracking disabled.
5. Show last heartbeat time and last RPC error in debug panel.
6. Show inside work area yes/no and detected staging zone yes/no.
7. In admin, show separate columns:
   - driver status,
   - driver current zone,
   - presence zone,
   - presence class,
   - count eligible yes/no,
   - mismatch flag.
8. Avoid using legacy `zone_stats.cars_staged` as if it is authoritative.
9. Clear or visually mark stale `currentZoneId` when status becomes passive/tracking_disabled.
10. Replace legacy `DriverToggle` with a modern “Tracking enabled” control if needed.

## 5. Terminal 1 UI explanation

The reported Samsung UI is internally explainable:

- AutoStatusBar showed Passive because Redux status was `passive_far`.
- ZoneListItem showed “You are here” because Redux `currentZoneId` equaled Terminal 1.
- Count showed 0 because the authoritative live stats had no countable fresh `driver_presence` row.
- Data stale likely came from stale/cached stats or failed live RPC refresh.
- ImStagingButton blocked because it requires status `active` or `staged`.

This is not just a cosmetic issue. It indicates missing atomic consistency between status, current zone, presence, and UI labels.
