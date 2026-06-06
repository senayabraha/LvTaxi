# Live Queue Count Analysis

Analysis-only documentation. This document traces how a driver becomes “1 car” in a staging-zone count and where the pipeline can fail.

## 1. Full live count pipeline

```text
GPS location
-> driver status decision
-> current zone decision
-> presence heartbeat
-> driver_presence table
-> active_driver_presence view
-> get_zone_live_stats()
-> useZones / zones.stats Redux state
-> ZoneListItem count display
-> admin DriversPage
```

## 2. What exact database row makes a driver count as “1 car”?

A driver counts when a row exists in `driver_presence` with:

```sql
driver_id = '<driver uuid>'
current_zone_id = '<staging zone uuid>'
classification in ('STAGING', 'UNKNOWN')
last_ping_at > now() - interval '90 seconds'
```

The `active_driver_presence` view applies this same rule. The `get_zone_live_stats()` RPC counts distinct `driver_id` grouped by `current_zone_id` under the same TTL/classification filter.

## 3. Does `drivers.status` matter directly for count?

Not directly inside SQL. The live count SQL does not join to `drivers.status`. However, `drivers.status` matters indirectly because the mobile heartbeat code refuses to write `driver_presence` unless Redux status is heartbeat-eligible (`active` or `staged`). If status is `passive_far`, a forced heartbeat still returns false.

## 4. Role of `driver_presence.classification`

Accepted counted values are:

- `STAGING`
- `UNKNOWN`

Uncounted values are:

- `ACTIVE`
- `PASSING`
- `DROP_OFF`
- `EXIT_GRACE`

`ACTIVE` should be used for a participating driver inside the work area but not in a staging queue. `STAGING` should be used for a driver inside a staging-zone polygon.

## 5. Role of `driver_presence.current_zone_id`

`current_zone_id` is mandatory for counting. A driver with `classification = STAGING` but null zone does not count because the view and RPC require a non-null zone.

## 6. Role of TTL / `last_ping_at`

The TTL is 90 seconds. Any row older than 90 seconds is excluded from live count. The app attempts a presence heartbeat every ~25 seconds while status is `active` or `staged`, which should refresh the row before expiry.

## 7. Scenario answers

| Scenario | Expected result |
|---|---|
| 90+ seconds with no heartbeat | Driver drops out of `active_driver_presence`; count decreases to 0 for that driver. |
| `status = active` with null zone | Presence may exist but classification/zone should be uncounted. |
| `status = staged` but no `driver_presence` row | UI may show staged/current zone, but live count remains 0. |
| Redux `currentZoneId` set but `driver_presence` missing | Zone card may say “You are here”; count remains 0. |
| Zone card says “You are here” but active view excludes row | Local UI and backend source of truth disagree. Driver is not counted. |
| `driver_presence.current_zone_id` set but classification `ACTIVE` | Not counted. |
| `driver_presence.classification = STAGING` but stale `last_ping_at` | Not counted. |

## 8. Frontend fetch logic

`useZones()` loads active, visible staging zones and `fetchLiveZoneStats()` in parallel. `fetchLiveZoneStats()` calls `supabase.rpc('get_zone_live_stats')`. The hook polls the live stats RPC every 30 seconds and subscribes to legacy `zone_stats` realtime updates for display refresh/flash behavior.

Important: realtime from `zone_stats` is not the source of truth for live count. It is a legacy/cache path. Enriched fields come from the RPC.

## 9. Stale-data detection logic

`ZoneListItem` derives freshness from `stat.last_updated` or `stat.updated_at`. Since `get_zone_live_stats()` returns `now()` as `last_updated`, a successful RPC poll should normally look fresh. A stale label can indicate no recent RPC result, cached stats, offline fallback, or the UI using older `zone_stats`/cached data.

## 10. All places queue count can become wrong

1. Status remains passive while physically in staging, so heartbeat is blocked.
2. `currentZoneId` exists in Redux but not in `driver_presence`.
3. `drivers.current_zone_id` exists but `driver_presence.current_zone_id` is null.
4. `driver_presence.classification` is `ACTIVE` or invalid.
5. `last_ping_at` is older than 90 seconds.
6. Supabase RPC write fails or is blocked by ownership/RLS/security-definer logic.
7. Work-area polygon fails to load, preventing active/staged transition.
8. Staging-zone polygon misses the physical queue.
9. `useZones()` falls back to cached `zone_stats` rather than live RPC.
10. Admin/user sees legacy `zone_stats.cars_staged` rather than live presence count.
11. Coming-soon/inactive/test zones are included in one path but excluded in another.
12. Native geofence top-20 filtering omits the physical zone.

## 11. Terminal 1 verification checklist

For a driver inside Terminal 1 staging, all must be true:

- `drivers.status = 'staged'`
- `drivers.current_zone_id = Terminal 1 zone id`
- `driver_presence.current_zone_id = Terminal 1 zone id`
- `driver_presence.classification IN ('STAGING', 'UNKNOWN')`
- `driver_presence.last_ping_at` is within 90 seconds
- `active_driver_presence` includes the row
- `get_zone_live_stats()` returns `cars_staged = 1`
- Mobile UI displays `1 car`

## 12. SQL verification queries

Replace placeholders before running.

### Inspect driver row

```sql
select id, email, full_name, status, current_zone_id, tracking_enabled,
       last_seen, work_area_entry_time, work_area_exit_started_at, gps_tier
from drivers
where id = '<driver_id>';
```

### Inspect presence row

```sql
select driver_id, current_zone_id, classification, last_ping_at,
       now() - last_ping_at as age, lat, lng, accuracy, speed, heading
from driver_presence
where driver_id = '<driver_id>';
```

### Check whether row is live-count eligible

```sql
select *
from active_driver_presence
where driver_id = '<driver_id>';
```

### Check live stats for Terminal 1

```sql
select *
from get_zone_live_stats()
where zone_id = '<terminal_1_zone_id>';
```

### Confirm the zone itself

```sql
select id, name, active, visible_to_drivers, is_coming_soon,
       lat, lng, radius_meters, circle_enabled,
       drawn_polygon is not null as has_drawn_polygon,
       driven_polygon is not null as has_driven_polygon,
       use_driven_polygon
from staging_zones
where id = '<terminal_1_zone_id>';
```

### Find presence rows counted by zone

```sql
select current_zone_id, classification, count(*) as drivers
from active_driver_presence
group by current_zone_id, classification
order by drivers desc;
```

### Compare drivers current zone to presence current zone

```sql
select d.id, d.email, d.status,
       d.current_zone_id as drivers_zone,
       p.current_zone_id as presence_zone,
       p.classification,
       p.last_ping_at,
       now() - p.last_ping_at as presence_age
from drivers d
left join driver_presence p on p.driver_id = d.id
where d.id = '<driver_id>';
```

## 13. Recommended count correctness rules

In the next implementation phase, mobile should not display “You are here” as a counted state unless status and presence agree. Suggested labels:

- `GPS says you are in this zone — not counted yet` when Redux zone exists but presence is missing/stale.
- `Staged and counted` when live stats includes the driver.
- `Staging detected — waiting for heartbeat` for the short transition window.
