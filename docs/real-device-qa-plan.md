# LV Taxi — Real-Device QA Plan

> Analysis-only. Practical field-testing checklist. Simulators validate UI only — never final GPS.

---

## 1. Devices

- **Samsung Android** (primary — battery-optimization aggressive; reproduces the T1 bug).
- A second Android (e.g. Pixel) if available (cleaner background behavior baseline).
- **iPhone** (iOS background-mode behavior).
- Simulator/emulator: basic UI flows only.

## 2. Conditions to exercise (each location)

App foreground · backgrounded · screen locked · app reopened · app force-closed ·
battery saver ON · battery saver OFF · permission While-Using · permission Always/Background ·
network online · network offline-then-online.

## 3. Locations

Far outside work area · near (outside) · inside work area (not staging) · Terminal 1 staging ·
Terminal 3 staging · one hotel staging zone · leaving staging (still in work area) · leaving work
area · re-enter during exit grace · stay outside 30+ min.

## 4. Per-test expectations (capture all)

starting status · expected status · expected task running · expected `drivers` row ·
expected `driver_presence` row · `active_driver_presence` result · expected zone count ·
expected UI text · expected admin row · expected debug-panel values.

## 5. QA table

| ID | Scenario | Steps | Expected mobile UI | Expected `drivers` | Expected `driver_presence` | Expected count | Expected admin | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|---|---|
| QA-01 | Far outside | Drive >3km away, foreground | ⚪ "Passive (far)" | status=passive_far, zone null | no fresh row | n/a | offline | | passive ~20min GPS |
| QA-02 | Near outside | Within 3km, outside | 🔵 "Passive (near)" | passive_near | no fresh row | n/a | offline | | ~5min GPS |
| QA-03 | Inside work area, no zone | Enter work area | 🟢 "Active" | active, zone null | row, classification ACTIVE, zone null | 0 in any zone | online | | heartbeat starts |
| QA-04 | Terminal 1 staging (fg) | Enter T1, GPS≤50m, 2 min fg | 🟡 "Staging T1", "You are here #1", N cars≥1, fresh | staged, zone=T1 | row STAGING, zone=T1, fresh | T1=1 | online+staged | | core test |
| QA-05 | T1 staging (bg) | Background 2 min | counts persist; updates within 90s | staged | last_ping_at refreshed <90s | T1=1 | online | | FGS keeps alive |
| QA-06 | T1 locked screen | Lock 2 min | counts persist | staged | refreshed | T1=1 | online | | |
| QA-07 | T1 force-closed | Swipe away 2 min | may stop; geofence may persist | staged→maybe stale | stops refreshing | T1 decrements after 90s | stale | | document actual |
| QA-08 | T3 staging | Enter T3 | "Staging T3" | staged, zone=T3 | STAGING, T3 | T3=1 | online+staged | | |
| QA-09 | Hotel staging | Enter hotel zone | "Staging [hotel]" | staged | STAGING | hotel=1 | online | | |
| QA-10 | Leave staging, in area | Exit zone, stay in work area | 🟢 "Active" | active, zone null | ACTIVE, zone null | prev zone −1; departure logged | online | | check zone_departures |
| QA-11 | Leave work area | Exit work area | 🟠 "Leaving area" | exit_grace, exit_started_at set | cleared | 0 | stale→offline | | timestamp grace |
| QA-12 | Re-enter during grace | Return <30min | back to active/staged | active/staged | resumes | resumes | online | | grace cancelled |
| QA-13 | Stay outside 30+ min | Wait out grace | passive | passive_far/near | cleared | 0 | offline | | grace expiry |
| QA-14 | Battery saver ON at T1 | Repeat QA-04 with saver on | should still stage | staged | fresh | T1=1 | online | | **Samsung risk** |
| QA-15 | Permission While-Using only | Grant WIU not Always | bg may fail | varies | may not refresh in bg | unreliable | stale in bg | | verify prompt to upgrade |
| QA-16 | Offline then online at T1 | Toggle airplane mode | queued writes flush | staged | catches up after reconnect | T1=1 after sync | online after sync | | offlineRetryManager |

## 6. Samsung Terminal 1 regression test (explicit)

**Steps:**
1. Fresh-install on the Samsung.
2. Grant **all** location permissions (When-Using → **Always/Background**).
3. Confirm `tracking_enabled = true`.
4. Drive to Terminal 1 staging.
5. Wait for a GPS fix ≤50 m.
6. Keep app foreground 2 min.
7. Background the app 2 min.
8. Check UI + Supabase.

**Expected:**
- `drivers.status` becomes `staged`.
- `driver_presence.current_zone_id` = Terminal 1.
- `driver_presence.classification` = `STAGING`.
- `last_ping_at` refreshed within 90 s.
- Terminal 1 count = 1.
- No "Data stale" while live stats are fresh.
- "I'm Staging" does **not** say "Go online first".

**If it fails, capture (for root-cause):**
- Whether an active `work_areas` polygon contains T1 (the §1 hypothesis).
- `drivers.status` sequence and whether a passive write overrode a staged write.
- Whether `driver_presence` ever received a row.
- Debug panel: inside-work-area yes/no, last background-task run, last heartbeat result.
- Samsung battery settings (app set to "Unrestricted"?).

Use the SQL in `live-queue-count-analysis.md` §6 to verify each step.
