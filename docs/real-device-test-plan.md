# LV Taxi — Real-Device Test Plan

Scenarios that cannot be covered by the Jest suite or Supabase SQL tests because
they depend on native OS behaviour: background task scheduling, geofence events,
GPS hardware, network transitions, and multi-device session management.

Run this plan on the test build before each release. Record pass/fail and the
exact Supabase rows produced for each scenario.

---

## Setup

1. Install a fresh Expo development build (not Expo Go) on at least one Android
   and one iOS device.
2. Confirm the Supabase project ref `tcdrsuiemtktvtodypka` is the target.
3. Open a Supabase SQL editor tab with the following monitoring query pinned:

   ```sql
   SELECT dp.driver_id, dp.current_zone_id, dp.classification,
          dp.last_ping_at, dp.device_id, dp.session_id,
          dp.lat, dp.lng, dp.accuracy
   FROM driver_presence dp
   ORDER BY dp.last_ping_at DESC;
   ```

4. Pin a second tab for zone visits:

   ```sql
   SELECT id, driver_id, zone_id, entered_at, exited_at, classification
   FROM zone_visits
   ORDER BY entered_at DESC
   LIMIT 20;
   ```

---

## Scenario 1 — GEO-1: Cold Background Relaunch

**What it tests:** `GEOFENCE_TASK` is registered at module scope in `App.jsx` so
a headless background relaunch triggered by a native geofence event fires the
Enter handler and creates a `zone_visits` row without the driver opening the app.

**Steps:**

1. Log in as a test driver, grant background location permission ("Always").
2. Force-quit the app completely (swipe away from recents, not just home).
3. Physically drive into — or simulate GPS coordinates inside — a monitored
   staging zone polygon.
4. Wait up to 60 seconds without opening the app.

**Expected:**

- A `zone_visits` row appears with `entered_at` set and `exited_at = NULL`.
- `driver_presence` shows `classification = STAGING` for the driver.
- The app was never foregrounded.

**Fail signal:** No `zone_visits` row after 60 s, or the row only appears after
opening the app.

---

## Scenario 2 — Background Permission Degraded Banner

**What it tests:** When the driver grants "While Using" (foreground-only) instead
of "Always", the app surfaces a degraded banner and heartbeats stop when backgrounded.

**Steps:**

1. Revoke background location on the device (Settings → App → Location →
   "While Using").
2. Open the app and navigate to the home screen.
3. Confirm a degraded or warning banner appears indicating background tracking is
   limited.
4. Begin staging (tap "I'm Staging" or drive into a zone while the app is open).
5. Background the app (press home).
6. Wait 95 seconds.

**Expected:**

- A degraded/warning banner is visible in the foreground before backgrounding.
- After 95 s backgrounded, the driver's `driver_presence.last_ping_at` is more
  than 90 s old and the driver no longer appears in `eligible_driver_presence`.
- `cars_staged` for the zone decrements on the next snapshot refresh.

**Fail signal:** Driver stays counted past 90 s after backgrounding with
foreground-only permission, or no banner appears.

---

## Scenario 3 — Force-Close Staleness UI

**What it tests:** After force-closing the app while staged, the driver's presence
row expires within 90 s and the count drops; if any freshness UI is visible before
close it correctly shows staleness age.

**Steps:**

1. Open the app, stage in a zone (confirm `cars_staged` increments).
2. While staged and the zone list is visible, force-quit the app.
3. Reopen the app immediately and watch the `ZoneListItem` freshness label
   (bottom meta row) for the zone you were in.
4. Wait 90 s total from the force-close.

**Expected:**

- The freshness label ("Updated Xs ago") ages in real time.
- Within 90–95 s of force-close, `driver_presence.current_zone_id` is nulled by
  `clear_stale_driver_presence()` and `cars_staged` drops to its correct value.

**Fail signal:** Driver remains in `eligible_driver_presence` past 95 s, or the
freshness label stays fixed at "Live" indefinitely.

---

## Scenario 4 — Zone A to Zone B (Heartbeat Throttle Reset)

**What it tests:** Moving from one staging zone to another resets the heartbeat
throttle so presence updates to Zone B immediately rather than waiting out the
25-second window.

**Steps:**

1. Stage in Zone A (confirm presence row shows Zone A, `classification = STAGING`).
2. Within 10 seconds, physically move — or set GPS — to inside Zone B's polygon.
3. Watch `driver_presence` in Supabase.

**Expected:**

- Within ~2 s of the location fix placing the driver inside Zone B, a new
  heartbeat fires (throttle was reset by `resetPresenceHeartbeat()` on
  `enterStagingZone`).
- `driver_presence.current_zone_id` updates to Zone B.
- Zone A count decrements, Zone B count increments on the next snapshot.

**Fail signal:** `driver_presence` still shows Zone A after 25+ s (throttle was
not reset).

---

## Scenario 5 — Duplicate Device / Last-Session-Wins

**What it tests:** Two devices logged into the same driver account produce only
one counted presence row, and the newer session's writes take precedence.

**Steps:**

1. Log into the test account on Phone A. Begin staging. Confirm presence row shows
   Phone A's `session_id` and `device_id`.
2. Log into the same account on Phone B (without logging out of A). Begin staging
   on Phone B.
3. Return to Phone A and trigger a heartbeat (move slightly so a location update
   fires).
4. Watch `driver_presence` — there is still only one row per `driver_id`.

**Expected:**

- Only one `driver_presence` row for the driver exists at all times.
- After Phone B logs in and sends a heartbeat, its `session_id` (lexically later)
  takes ownership of the row. Phone A's subsequent heartbeats are silently ignored
  by the RPC (last-session-wins).
- `cars_staged` never exceeds 1 for that zone from this driver.

**Fail signal:** Two separate rows (impossible with the current schema, but worth
confirming), or `cars_staged` shows 2 for a zone with one physical driver.

---

## Scenario 6 — Manual Staging Polygon Rejection and Acceptance

**What it tests:** The "I'm Staging" button correctly rejects taps from outside
the zone polygon and accepts taps from inside, and creates exactly one
`zone_visits` row.

**Steps (rejection):**

1. Stand 200 m from a zone's polygon boundary.
2. Tap "I'm Staging" for that zone.
3. Confirm the UI shows a rejection message (no staging state change).
4. Confirm no `zone_visits` row is created with `entered_at` within this window.

**Steps (acceptance):**

5. Move to inside the polygon (confirm GPS accuracy ≤ 50 m).
6. Tap "I'm Staging".
7. Confirm `classification = STAGING` in `driver_presence`.
8. Confirm exactly one open `zone_visits` row (no duplicates even if tapped twice).

**Expected (rejection):** No new `zone_visits` row, driver not counted.

**Expected (acceptance):** Exactly one `zone_visits` row with `exited_at = NULL`,
`driver_presence.classification = STAGING`, `cars_staged` increments.

**Fail signal:** Staging succeeds from outside the polygon, or multiple `zone_visits`
rows appear after multiple taps.

---

## Scenario 7 — Android Mock Location Rejection

**What it tests:** A location fix with `mocked = true` (from a developer mock GPS
app) is rejected by `isFixAcceptableForPresence` before it reaches the RPC, so
the driver is never counted as `STAGING`.

**Steps (Android only):**

1. Enable developer options and install a mock GPS app (e.g. "Fake GPS Location").
2. Set the mock location to inside a staging zone polygon.
3. Open the app and wait for a heartbeat attempt (up to 25 s).
4. Check `driver_presence` for the test driver.

**Expected:**

- `driver_presence` either has no row for the driver, or shows
  `classification = ACTIVE` / `current_zone_id = NULL`.
- `eligible_driver_presence` returns 0 rows for this driver.
- `cars_staged` for the zone is not incremented.

**Fail signal:** Driver appears in `eligible_driver_presence` or `cars_staged`
increments while mock GPS is active.

---

## Scenario 8 — Offline Ambiguous-Visit Confirmation Replay

**What it tests:** When a driver taps YES/NO on the ambiguous-visit confirmation
prompt while the device is offline, the `SAVE_TRAINING_DATA` side-effect is queued
to AsyncStorage and replays after reconnect.

**Steps:**

1. Stage, exit a zone, and wait for the ambiguous-visit prompt (the AI classified
   the visit as ambiguous).
2. Disable all network access on the device (airplane mode).
3. Tap YES (confirming the visit was a staging).
4. Confirm no network error dialog appears; the UI accepts the tap.
5. Re-enable network.
6. Trigger a reconnect event (open the app if needed).

**Expected:**

- `zone_visits` row for the visit shows `driver_confirmed = true` and
  `confirmed_label = 'staging'` within a few seconds of reconnect.
- `trajectories` row shows `ground_truth = 'staging'`.

**Fail signal:** Row still shows `driver_confirmed = false` after reconnect, or
the tap produces an error dialog.

---

## Scenario 9 — Cached Stats Degraded Banner

**What it tests:** When both the snapshot table and the live RPC fail (simulated
by temporarily blocking network or using a test override), the app falls back to
the legacy `zone_stats` table and shows "Showing cached stats — live data unavailable."

**Steps:**

1. With the app open and live stats visible, temporarily block Supabase API
   access (e.g. toggle airplane mode, then back on before zones finish loading —
   or use a proxy to drop the RPC response).
2. Pull-to-refresh the zone list.

**Expected:**

- A yellow banner appears: "Showing cached stats — live data unavailable."
- The zone counts still show the last known values (cached).

**Fail signal:** No banner appears, or the app crashes / shows a blank list.

---

## Scenario 10 — Nearest-20 Geofence Monitoring (GEO-3)

**What it tests:** Geofence monitoring selects the nearest 20 zones by physical
distance regardless of the active UI sort (Flow / Wait / Nearest).

**Steps:**

1. Set the UI sort to "Wait" (longest wait first).
2. Drive — or simulate GPS — toward a zone that would rank low by wait time but
   is physically the nearest.
3. Confirm the Enter event fires for that zone.

**Expected:**

- `zone_visits` row created for the physically nearest zone, not the one at the
  top of the Wait-sorted list.

**Fail signal:** No Enter event for the physically nearest zone; Enter fires for
a zone that only ranks high by wait time.

---

## Pass Criteria

All 10 scenarios must pass before the build is cleared for broader driver testing.
Record the test date, device models, OS versions, and tester initials against each
scenario result.

| # | Scenario | Android result | iOS result | Date | Tester |
|---|----------|----------------|------------|------|--------|
| 1 | Cold background relaunch | | | | |
| 2 | Background permission banner | | | | |
| 3 | Force-close staleness UI | | | | |
| 4 | Zone A → Zone B throttle reset | | | | |
| 5 | Duplicate device / last-session-wins | | | | |
| 6 | Manual staging polygon reject/accept | | | | |
| 7 | Android mock location rejection | n/a iOS | | | |
| 8 | Offline confirmation replay | | | | |
| 9 | Cached stats degraded banner | | | | |
| 10 | Nearest-20 geofence monitoring | | | | |
