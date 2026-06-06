# LV Taxi — UI State Consistency Analysis

> Analysis-only. Every status/count/zone UI element, its data source, and possible contradictions.

---

## 1. Element-by-element

| Element (file) | Displays | Reads | Can go stale? | Agrees with truth? |
|---|---|---|---|---|
| `AutoStatusBar.jsx` | status label + zone name + GPS tier | Redux `drivers.status`, `currentZoneId`, `gpsTier` | yes (Redux only) | only if status writers are correct |
| `StatusToggle.jsx` | status display/toggle | Redux `drivers.status` | yes | mirrors Redux |
| `DriverToggle.jsx` | legacy off/on toggle | Redux `drivers.status` → sets `off_duty`/`active` (`:52`) | n/a | **conflicts** with automatic machine |
| `ImStagingButton.jsx` | "I'm Staging" + gating | `canStage` = status in {active,staged} (`:24`); sets `staged` (`:32`) | n/a | gated by status only |
| `ZoneListItem.jsx` | cars, wait range, "You are here — #N", freshness | props from HomeScreen: `stat` (RPC), `isCurrentZone` (Redux `currentZoneId`), `driverPosition` | yes | **mixes Redux + RPC sources** |
| `HomeScreen.jsx` | zone list, `isCurrentZone`, position | Redux `currentZoneId`, `useZones` stats, `getDriverPositionInZone` | yes | composition point of the contradiction |
| `ProfileScreen.jsx` | profile/status | Redux `drivers` / profile | yes | should match Home |
| `TrackingDebugPanel.jsx` | debug | Redux + `trackingDebug` | yes | limited fields today |
| admin `DriversPage.jsx` | online/stale/offline, staged | `driver_presence.last_ping_at` (90s/30min) | yes | DB-based |
| admin `SystemCheckPage.jsx` | health checks | auth/role/zones/RPC | n/a | infra checks |
| admin `zoneHealth.js` | zone health | `staging_zones` + stats (5-min stale) | yes | different staleness window |

## 2. The three staleness windows (inconsistency)

- Live count TTL / mobile "Data stale": **90 s** (`PRESENCE_TTL_SECONDS`, `ZoneListItem.jsx:98`).
- Admin driver online→stale: **90 s online, 30 min stale** (`DriversPage.jsx:8`).
- Admin zone health stale: **5 min** (`zoneHealth.js:11`).

Three different thresholds describing "freshness" invite contradictory readouts across surfaces.

## 3. Contradiction catalog

1. **Top "Passive" while card says "You are here".** Status (Redux) and `currentZoneId` (Redux) are
   independent reducers; `currentZoneId` not cleared on a passive `setStatus` (`driversSlice.js:59-70`).
2. **"You are here" but count 0.** "You are here" = Redux `currentZoneId`; count = DB presence. No
   presence row ⇒ 0.
3. **Staged but no current zone.** Possible if `setStatus(STAGED)` runs without `currentZoneId` set,
   or zone cleared after.
4. **Current zone but status active/passive.** Geofence set zone; promotion overridden / never ran.
5. **Admin "online" but mobile "passive".** Admin reads `last_ping_at` freshness; a recent residual
   ping can show online briefly while the client status already dropped to passive.
6. **"Data stale" while actively heartbeating.** RPC `last_updated=now()`, so this reflects the
   *client* not refreshing (poll/realtime gap) or `zone_stats` fallback, not the driver's heartbeat.
7. **"I'm Staging" disabled in staging.** `canStage` requires status active/staged; if the work-area
   gate kept the driver passive, the button is disabled even physically in the lane.
8. **Profile vs Home status differ.** Both read Redux; a divergence implies a render/timing issue,
   not separate sources.
9. **Zone highlight from Redux `currentZoneId`** persists across status changes (not persisted across
   app restart since store isn't persisted, but persists within a session until `zoneExited`/
   `setCurrentZone(null)`).
10. **Legacy `DriverToggle`** can force `off_duty`/`active`, contradicting the read-only automatic
    design and silently stopping counts.

## 4. Recommended UI rules (not implemented)

- If `currentZoneId` set but status is passive/exit_grace → show a warning chip ("position not
  counted — not on duty here") instead of plain "You are here".
- Show the reason "I'm Staging" is disabled (e.g. "outside work area" / "GPS not fixed").
- Distinguish "Not counted yet" vs "Staged" using the actual `driver_presence` state, not just Redux.
- Show last heartbeat time and inside-work-area yes/no in the debug panel.
- Label "You are here" explicitly as GPS-nearest/current-zone unless status **and** presence agree.
- Unify the staleness vocabulary across mobile + admin (single TTL constant + derived labels).

See `driver-status-state-machine.md` §4 (case study), `fix-roadmap.md` P0/P3.
