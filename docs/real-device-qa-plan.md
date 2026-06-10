# Real-Device QA Plan

Analysis-only documentation. This is a field-testing checklist for LV Taxi. It does not change code.

## 1. QA principles

Simulator testing is useful for layout and simple state rendering, but final validation for LV Taxi must happen on real devices because GPS, background execution, permissions, foreground services, battery optimization, and OS task delivery are device-specific.

The primary QA objective is to prove this end-to-end invariant:

```text
Physical location in staging zone
-> status = staged
-> drivers.current_zone_id = zone id
-> driver_presence fresh and STAGING
-> active_driver_presence includes driver
-> get_zone_live_stats cars_staged includes driver
-> mobile/admin UI agree
```

## 2. Required test devices

- Samsung Android device.
- One additional Android device if available.
- iPhone.
- Simulator only for basic UI/layout smoke testing, not final GPS validation.

## 3. Required test conditions

Test each critical location under these conditions:

- App foreground.
- App backgrounded.
- Phone locked.
- App reopened.
- App force-closed/swiped away.
- Battery saver on.
- Battery saver off.
- Android battery optimization unrestricted vs optimized.
- Location permission while using only.
- Location permission always/background.
- Network online.
- Network offline then online.

## 4. Required test locations

- Far outside work area.
- Near work area but outside.
- Inside work area but not staging.
- Terminal 1 staging.
- Terminal 3 staging.
- One hotel staging zone.
- Leaving staging but still inside work area.
- Leaving work area.
- Re-entering during exit grace.
- Remaining outside work area for 30+ minutes.

## 5. Pre-test setup

Before each field run:

1. Install a fresh app build.
2. Sign in as a known test driver.
3. Confirm `drivers.tracking_enabled = true`.
4. Confirm no stale zone/current state:

```sql
select id, status, current_zone_id, tracking_enabled, last_seen,
       work_area_exit_started_at
from drivers
where id = '<driver_id>';

select *
from driver_presence
where driver_id = '<driver_id>';
```

5. Confirm active work areas exist.
6. Confirm the target staging zone is active, visible, not coming soon, and has geometry.
7. Confirm phone settings:
   - precise location enabled,
   - background location allowed,
   - battery optimization unrestricted for the app,
   - network available.

## 6. QA table

| Test ID | Scenario | Steps | Expected mobile UI | Expected drivers table | Expected driver_presence table | Expected queue count | Expected admin result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GPS-001 | Far outside work area | Open app far from work area; wait for GPS fix. | Passive (far); no current zone; I’m Staging disabled with reason. | `status = passive_far`, `current_zone_id = null`. | No row or uncounted/null zone. | No count. | Offline/passive, no count eligible row. |  |  |
| GPS-002 | Near work area outside | Drive near boundary but not inside. | Passive (near). | `status = passive_near`. | No countable presence. | No count. | Passive/near if supported; no count. |  |  |
| GPS-003 | Inside work area not staging | Enter work area but avoid staging zones. | Active; no “You are here.” | `status = active`, `current_zone_id = null`. | Fresh row, `classification = ACTIVE`, `current_zone_id = null`. | No zone count. | Online active. |  |  |
| GPS-004 | Terminal 1 staging foreground | Enter Terminal 1 staging, keep app open 2 minutes. | Staging at Terminal 1; Terminal 1 shows 1 car; no stale label. | `status = staged`, `current_zone_id = T1`. | Fresh row, `classification = STAGING`, `current_zone_id = T1`. | T1 `cars_staged >= 1`. | Online/staged/count eligible. |  |  |
| GPS-005 | Terminal 1 staging background | From GPS-004, background app for 2 minutes. | On reopen still staging; no stale if heartbeat ran. | Still staged/T1. | `last_ping_at` within 90s if background works. | T1 count remains 1. | Online/staged. |  |  |
| GPS-006 | Terminal 1 locked screen | Lock phone 2 minutes while staged. | On unlock/reopen still staged if background works. | Still staged/T1. | Fresh heartbeat. | Count remains 1. | Online/staged. |  |  |
| GPS-007 | Terminal 3 staging | Repeat Terminal 1 procedure at T3. | Staging at T3; T3 1 car. | `status = staged`, `current_zone_id = T3`. | Fresh STAGING/T3. | T3 count 1. | Online/staged. |  |  |
| GPS-008 | Hotel staging | Repeat at one hotel zone. | Staging at hotel zone; count 1. | `status = staged`. | Fresh STAGING. | Count 1. | Online/staged. |  |  |
| GPS-009 | Leave staging but remain in work area | Drive out of staging polygon but stay in work area. | Active; no Terminal “You are here”; no counted queue. | `status = active`, zone null. | Fresh ACTIVE/null zone. | Previous zone count drops. | Online active. |  |  |
| GPS-010 | Leave work area | Drive outside work area. | Leaving area. | `status = exit_grace`, `current_zone_id = null`. | Presence cleared/null zone. | No count. | Stale/offline depending ping. |  |  |
| GPS-011 | Re-enter during grace | Re-enter work area within 30 min. | Active or staged based on location. | `status = active/staged`, exit timestamp null. | Fresh active/staging row. | Count only if staged. | Online. |  |  |
| GPS-012 | Grace expires | Stay outside 30+ min. | Passive far/near. | `status = passive_far/passive_near`. | No countable presence. | No count. | Offline/passive. |  |  |
| GPS-013 | Offline then online | Go offline while staged, wait 2 min, reconnect. | Offline warning; then recovers. | Status may stay staged; last_seen updates after reconnect. | Heartbeat stale while offline, fresh after reconnect. | Count drops after TTL, returns after heartbeat. | Stale then online. |  |  |
| GPS-014 | Permission revoked | Revoke location permission. | Tracking off / permission required. | `status = tracking_disabled`. | Presence cleared. | No count. | Offline/disabled. |  |  |
| GPS-015 | App force-closed | Force-close while staged, wait 2+ min. | On relaunch should reconcile; no promise while killed. | May stale until relaunch. | Likely stale after TTL. | Count likely drops. | Stale/offline, then recovers on launch. |  |  |
| GPS-016 | Battery saver on | Enable battery saver, test staged background. | Should warn if background delayed. | Status may remain but heartbeat may stale. | Check whether ping ages >90s. | Count may drop. | Stale if delayed. |  |  |

## 7. Samsung Terminal 1 regression test

### Steps

1. Install fresh app on Samsung.
2. Grant all location permissions, including background/always if available.
3. Disable battery optimization for LV Taxi.
4. Confirm `tracking_enabled = true`.
5. Drive to Terminal 1 staging.
6. Wait for GPS accuracy <= 50m.
7. Keep app foreground for 2 minutes.
8. Check mobile UI and Supabase.
9. Background app for 2 minutes.
10. Reopen app and check UI/Supabase again.

### Expected foreground result

- `status = staged`.
- `current_zone_id = Terminal 1 zone id`.
- `driver_presence.current_zone_id = Terminal 1 zone id`.
- `driver_presence.classification = STAGING`.
- `driver_presence.last_ping_at` refreshed within 90 seconds.
- `get_zone_live_stats()` returns `cars_staged = 1` or higher for Terminal 1.
- No “Data stale” if RPC polling is working.
- “I’m Staging” must not say “Go online first.”

### Expected background result

- Background task run time updates.
- Heartbeat remains within 90 seconds.
- Count remains 1.
- If Samsung blocks background updates, debug panel/admin must identify that background task or heartbeat did not run.

## 8. Per-test database checks

### Driver state

```sql
select id, email, full_name, status, tracking_enabled,
       current_zone_id, gps_tier, last_seen,
       work_area_entry_time, work_area_exit_started_at, work_area_exit_time
from drivers
where id = '<driver_id>';
```

### Presence state

```sql
select driver_id, current_zone_id, classification,
       last_ping_at, now() - last_ping_at as age,
       lat, lng, accuracy, speed, heading, active_visit_id
from driver_presence
where driver_id = '<driver_id>';
```

### Active presence eligibility

```sql
select *
from active_driver_presence
where driver_id = '<driver_id>';
```

### Zone live stats

```sql
select *
from get_zone_live_stats()
where zone_id = '<zone_id>';
```

### Zone config

```sql
select id, name, active, visible_to_drivers, is_coming_soon,
       lat, lng, radius_meters, circle_enabled,
       drawn_polygon is not null as has_drawn_polygon,
       driven_polygon is not null as has_driven_polygon,
       use_driven_polygon
from staging_zones
where id = '<zone_id>';
```

### Work-area config

```sql
select id, name, active, polygon is not null as has_polygon
from work_areas
where active = true;
```

## 9. Required debug panel values during field QA

- Current raw GPS and smoothed GPS.
- Accuracy in meters.
- Status and status source.
- `tracking_enabled`.
- Current zone id/name.
- Inside work area yes/no.
- Work-area polygon count.
- Detected staging zone id/name.
- Active/passive task running flags.
- Last active task run time.
- Last passive task run time.
- Last foreground GPS time.
- Last heartbeat attempt time.
- Last heartbeat success/error.
- `driver_presence` age.
- Last live stats RPC time/error.
- Battery optimization status/instructions.

## 10. Pass criteria for release

A release candidate should not be considered field-ready until:

- Samsung Terminal 1 foreground test passes.
- Samsung Terminal 1 background/locked test either passes or shows a clear device restriction warning.
- iPhone foreground/background tests pass.
- Work-area failure is visible in debug/admin tools.
- Staged/current-zone/presence mismatches are surfaced, not hidden.
- Admin can identify whether a driver is count eligible.
