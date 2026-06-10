# Geofence Entry QA

Manual verification for the confirmed geofence-entry path.

## Terminal 1 field check

1. Use a signed-in test driver with tracking enabled.
2. Stand physically inside the Terminal 1 staging polygon.
3. Wait for the native geofence enter event and polygon confirmation.
4. Confirm the app shows `staged`, not `passive_far` or `passive_near`.
5. Confirm Redux `currentZoneId` is the Terminal 1 zone id.
6. Confirm `driver_presence.classification = STAGING`.
7. Confirm `active_driver_presence` includes the driver.
8. Confirm `get_zone_live_stats()` returns `cars_staged = 1` for Terminal 1.

## Expected result

- Redux `status = staged`
- Redux `currentZoneId = <terminal_1_zone_id>`
- `drivers.status = staged`
- `drivers.current_zone_id = <terminal_1_zone_id>`
- `drivers.work_area_exit_started_at is null`
- `drivers.last_seen` is fresh
- `driver_presence.current_zone_id = <terminal_1_zone_id>`
- `driver_presence.classification = STAGING`
- `driver_presence.last_ping_at` is fresh
- `driver_presence.active_visit_id` is the inserted visit id when available
- `active_driver_presence` includes the driver
- `get_zone_live_stats()` returns `cars_staged = 1`

## SQL verification

Replace placeholders before running.

```sql
select status, current_zone_id, last_seen, work_area_exit_started_at
from drivers
where id = '<driver_id>';
```

```sql
select current_zone_id, classification, last_ping_at, lat, lng, active_visit_id
from driver_presence
where driver_id = '<driver_id>';
```

```sql
select *
from active_driver_presence
where driver_id = '<driver_id>';
```

```sql
select *
from get_zone_live_stats()
where zone_id = '<terminal_1_zone_id>';
```
