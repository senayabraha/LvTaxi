# LV Taxi — Driver Status State Machine

> Analysis-only. The most important deliverable. Includes the Samsung Terminal 1 case study.
>
> **Update (implementation):** a centralized transition helper now exists —
> `src/lib/driverStatusTransitions.js` — that keeps status + zone consistent at the
> updated call sites. See `status-transition-helper.md`. The §1 "no central state
> machine" finding below describes the pre-helper state; remaining un-converted
> sites are listed in the helper doc.

---

## 0. Summary verdict

- There is **no single source of truth / no centralized state machine.** `drivers.status` is the
  DB source of truth, mirrored into Redux `drivers.status`, but it is *written from at least 11
  call sites* across UI, geofence, two background tasks, the exit-grace manager, and app-launch
  reconciliation.
- `currentZoneId` (Redux) and `driver_presence.current_zone_id` (DB) are **independent** and can
  diverge. The UI's "You are here" reads Redux; the live count reads DB presence.
- The Redux store is **not persisted** (`src/store/index.js` has no redux-persist / rehydrate),
  so divergences arise *within a running session* from override ordering, not from stale rehydration.

---

## 1. Status catalog (per-status detail)

Enum: `DRIVER_STATUS` (`constants.js:194`). Redux initial = `tracking_disabled`
(`driversSlice.js:13`). DB default = `tracking_disabled` (migration `014`), CHECK allows the 7
values incl. legacy `off_duty` (`014_background_tracking_states.sql:26`).

### `tracking_disabled`
- **Meaning:** no tracking (logout / no permission / inactive account / user toggle off).
- **Set by:** `backgroundTrackingService.reconcileTrackingOnAppLaunch` (no permission / disabled),
  `driversSlice.clearProfile` (logout), `driversSlice.setTrackingEnabled(false)`.
- **DB cols:** `drivers.status`, `drivers.tracking_enabled`. **Redux:** `status`, `trackingEnabled`.
- **Heartbeats:** no. **Counts:** no. **zone_id:** null.
- **Entry:** logout, permission revoke, master toggle. **Exit:** reconcile with permission+enabled.
- **Risks:** if reconcile mis-detects permission, driver silently stops tracking.
- **UI:** AutoStatusBar 🔴 "Tracking off". **Admin:** offline.

### `passive_far` / `passive_near`
- **Meaning:** outside work-area polygon; far (>3 km) vs near (≤`PASSIVE_NEAR_THRESHOLD_METERS`
  3 km, `constants.js:222`).
- **Set by:** `passiveLocationTask.js:119` (reclassify), `exitGraceManager.js:134`
  (grace expiry → `classifyPassiveDistance`), `backgroundTrackingService` reconcile.
- **DB/Redux:** `status`. **Heartbeats:** **no** (`isHeartbeatStatus` false). **Counts:** no.
  **zone_id:** null (should be).
- **Entry:** outside work area. **Exit:** enter work-area polygon → active/staged.
- **Risks:** **if work-area polygon fails to load, a driver physically inside is classified
  passive** (fail-closed) and never heartbeats — primary Samsung suspect.
- **UI:** ⚪ "Passive (far)" / 🔵 "Passive (near)". **Admin:** offline (no fresh ping).

### `active`
- **Meaning:** inside work-area polygon, not in any staging zone.
- **Set by:** `passiveLocationTask.js:76` (upgrade), `activeLocationTask.js:91/97`,
  `geofenceEngine` (exit of zone → active path), reconcile.
- **DB/Redux:** `status`, `current_zone_id=null`, `work_area_entry_time`.
- **Heartbeats:** **yes** with `classification='ACTIVE'`, zone null (`presenceHeartbeat.js:78-84`).
  **Counts:** **no** (null zone). **zone_id:** null.
- **Entry:** enter work area. **Exit:** enter zone (→staged) / leave work area (→exit_grace).
- **Risks:** heartbeats but null zone → present in admin "online" but not in any queue (correct).
- **UI:** 🟢 "Active". **Admin:** online.

### `staged`
- **Meaning:** inside a staging-zone polygon; counted.
- **Set by:** `geofenceEngine.completeHandleEnter:86` (polygon-confirmed enter),
  `passiveLocationTask.js:76` (direct into zone), `activeLocationTask.js:91`,
  `ImStagingButton.jsx:32` (manual).
- **DB/Redux:** `status='staged'`, `current_zone_id=zone`. Heartbeat classification `STAGING`.
- **Heartbeats:** **yes** (zone set). **Counts:** **yes** (`countsInStagingMath` true).
  **zone_id:** zone id.
- **Entry:** polygon-confirmed zone enter, or manual "I'm Staging". **Exit:** leave zone, leave
  work area, grace.
- **Risks:** if status promoted but heartbeat blocked (timing) or work-area override flips back to
  passive without clearing `currentZoneId`, UI shows zone but count=0.
- **UI:** 🟡 "Staging [zone]". **Admin:** online + staged.

### `exit_grace`
- **Meaning:** just left work-area polygon; 30-min timestamp grace; NOT counted.
- **Set by:** `exitGraceManager.js:60/96`, `backgroundTrackingService.js:314` (launch outside).
- **DB/Redux:** `status`, `work_area_exit_started_at` (DB + Redux `workAreaExitStartedAt`).
- **Heartbeats:** **no** (cleared via `clear_driver_presence`). **Counts:** no.
- **Entry:** leave work area while active/staged. **Exit:** re-enter (→active/staged) or expiry
  (→passive). Re-entry cancels via `clearExitGrace`.
- **Risks:** `upsert_driver_presence` whitelist in migration `012:46` does **not** include
  `EXIT_GRACE` (added later in `014`); if migrations applied out of order an EXIT_GRACE write
  normalizes to `ACTIVE`. Design intent is to *clear* presence in grace, not write it.
- **UI:** 🟠 "Leaving area". **Admin:** stale → offline.

### `off_duty` (legacy)
- **Meaning:** backward-compat only. **Set by:** `DriverToggle.jsx:52` (legacy manual toggle),
  `soft_delete_driver()`.
- **Heartbeats/Counts:** no. **UI:** 🔴 "Off Duty" (fallback in `AutoStatusBar`).
- **Risk:** `DriverToggle` still toggles `off_duty ↔ active`, conflicting with the automatic
  machine (see Q9).

---

## 2. Transition matrix

| From → To | Trigger | Where |
|---|---|---|
| tracking_disabled → passive_far/near | permission+enabled, outside | reconcile + passiveTask |
| tracking_disabled → active | permission+enabled, inside work area | reconcile/passiveTask |
| passive_far ↔ passive_near | cross 3 km boundary | `passiveLocationTask.js:112-120` |
| passive_* → active | enter work-area polygon, no zone | `passiveLocationTask.js:70-108` |
| passive_* → staged | enter work-area polygon **and** zone | `passiveLocationTask.js:70-108` |
| active → staged | enter zone polygon | `geofenceEngine.js:86`, `activeLocationTask.js:91` |
| staged → active | leave zone, still in work area | `geofenceEngine handleExit` / activeTask |
| active/staged → exit_grace | leave work-area polygon | `exitGraceManager.js:60` |
| exit_grace → active/staged | re-enter work area | activeTask + `clearExitGrace` |
| exit_grace → passive_* | 30-min expiry | `exitGraceManager.js:134` |
| any → tracking_disabled | logout/revoke/toggle | clearProfile / setTrackingEnabled / reconcile |
| off_duty → automatic | next reconcile/upgrade | reconcile/passiveTask |

---

## 3. Investigation answers

1. **Single source of truth for the state machine?** No. DB `drivers.status` is authoritative for
   persistence, but transition *logic* is spread across 6 modules.
2. **Centralized or spread?** Spread. `persistDriverStatus` (`backgroundTrackingService.js:71`) is
   the closest thing to a funnel, but UI, geofence, and exit-grace also write directly.
3. **Does `geofenceEngine.zoneEntered()` run without `status=staged`?** `zoneEntered` (sets
   `currentZoneId` only) runs at `geofenceEngine.js:59`, and `completeHandleEnter` then calls
   `persistDriverStatus(STAGED)` at line 86 **before** the forced heartbeat. So *within that path*
   status is promoted. **But** the promotion can be (a) overwritten afterward by a passive task /
   reconcile that re-checks the work area, or (b) never reached if `verifyWithPolygon` keeps
   deferring entry — while `currentZoneId` may already be set elsewhere.
4. **Can `currentZoneId` be set while status is passive?** **Yes.** `setCurrentZone` /`zoneEntered`
   and `setStatus(passive_*)` are independent reducers (`driversSlice.js:59-117`). Nothing clears
   `currentZoneId` when status drops to passive_far via `setStatus`. (`zoneExited`/`setCurrentZone(null)`
   would clear it, but a passive reclassify path does not always call them.)
5. **Can UI show "You are here" while passive?** **Yes** — `ZoneListItem` "You are here" is driven
   purely by `currentZoneId === zone.id` (`HomeScreen.jsx:166`, `ZoneListItem.jsx:264`), independent
   of `status`.
6. **Can a driver be in a zone but not counted because status is passive?** **Yes** — counting
   requires a fresh `driver_presence` row with `classification in (STAGING,UNKNOWN)`; passive status
   blocks the heartbeat (`presenceHeartbeat.js:46`), so no counting row is written.
7. **Can `maybeSendPresenceHeartbeat` block forced writes while passive?** **Yes** — the
   `isHeartbeatStatus` guard at `presenceHeartbeat.js:46` runs *before* the `force` check at line 49,
   so `force:true` does **not** override a passive status.
8. **Does `ImStagingButton` set all required fields?** It gates on `canStage` (status active/staged)
   and on success sets `status=staged` (`ImStagingButton.jsx:32`). It relies on the subsequent
   heartbeat to write presence. If pressed while passive it only shows "Go online first"
   (`ImStagingButton.jsx:24`) and changes nothing.
9. **Does `DriverToggle` conflict with the automatic machine?** **Yes (latent).** It toggles
   `off_duty ↔ active` (`DriverToggle.jsx:52`), a legacy manual model that fights the automatic
   GPS-driven transitions. If surfaced, it can force `off_duty` (no heartbeat, no count) or `active`
   irrespective of polygon position.
10. **Is `off_duty` still dangerous?** It is still a valid CHECK value and still settable via
    `DriverToggle` and `soft_delete_driver`. It is excluded from heartbeat/count predicates, so it
    "safely" removes a driver — but a stray `off_duty` will silently stop counting.

---

## 4. Case study — Samsung at Terminal 1

**Observed (all at once):** top bar "Passive (far)"; zone card "You are here — Position #1";
"0 car"; "Data stale"; "I'm Staging" → "Go online first to use staging".

**Why these co-occur — mechanism.** Each symptom reads a *different* source:

| Symptom | Reads | Implication |
|---|---|---|
| "Passive (far)" | Redux `drivers.status` (`AutoStatusBar.jsx:7`) | status = `passive_far` |
| "You are here — #1" | Redux `currentZoneId` (`HomeScreen.jsx:166`) | `currentZoneId` = T1, set at some point |
| "0 car" | `get_zone_live_stats().cars_staged` (DB presence) | no fresh STAGING presence row for T1 |
| "Data stale" | `zone last_updated` age > 90 s (`ZoneListItem.jsx`) | RPC count not refreshing for T1 |
| "Go online first" | `canStage` = status in {active,staged} (`ImStagingButton.jsx:24`) | status not active/staged |

So the unifying fact is: **`status = passive_far` while `currentZoneId = T1`, and no presence row
is being written** (because passive blocks the heartbeat → `presenceHeartbeat.js:46`).

**Root-cause hypotheses (ranked):**

1. **Work-area polygon not loaded / driver judged "outside" (MOST LIKELY).** If the active
   `work_areas` polygon failed to load (empty table, cache miss on a fresh install, malformed
   polygon, or `useZones`/work-area fetch failing), `isInsideWorkAreaPolygon` returns false. The
   passive task / reconcile then *keeps or forces* `passive_far` even though the driver is inside
   T1. A geofence circle Enter (independent of work area) may still have set `currentZoneId`
   ("You are here"), but the passive classification overwrote `status` back to `passive_far`
   **without clearing `currentZoneId`**. Passive ⇒ no heartbeat ⇒ 0 cars + data stale; passive ⇒
   "Go online first". Fail-closed work-area gate explains *all five* symptoms.

2. **Background task never fired on the Samsung (battery optimization).** Fresh install + Samsung
   Knox/battery saver can prevent the active/passive task from waking. The native geofence Enter
   (cheaper, OS-level) fired once and set `currentZoneId`, but the active task that would promote to
   `staged` and start heartbeating never ran, leaving the reconciled status at `passive_far`. No
   foreground-service exemption is requested (`app.config.js`), increasing this risk on Samsung.

3. **Status-override race between writers.** `geofenceEngine.completeHandleEnter` promotes to
   `staged`, but a near-simultaneous passive task / reconcile pass re-evaluates and writes
   `passive_far` last. Because writers are uncoordinated (no central machine), last-writer-wins can
   land on passive while `currentZoneId` remains set.

4. **Polygon verification too strict.** If T1 uses a tight `driven_polygon` and the GPS fix sat
   just outside it, `verifyWithPolygon` (`geofenceEngine.js:41`) keeps deferring entry
   (`handleEnter` retry loop), so `completeHandleEnter` (and the STAGED promotion) never runs; a
   different code path had set `currentZoneId`.

**Why #1 is favored:** it is the single condition that simultaneously forces passive, blocks
heartbeats, disables staging, *and* is consistent with `currentZoneId` being set by an independent
geofence circle. It is also the most common real-world failure for a lone tester on a fresh device.

**Confirmation needed (Supabase / device):** is there an active `work_areas` row whose polygon
contains T1? Did `driver_presence` ever receive a row for this driver/zone? What status sequence
landed in `drivers.status`? See `real-device-qa-plan.md` regression test and
`live-queue-count-analysis.md` SQL.
