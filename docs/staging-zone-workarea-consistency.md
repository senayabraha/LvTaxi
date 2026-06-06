# Staging Zone / Work-Area Consistency

Staging-zone polygons and work-area polygons must agree. A driver physically inside a staging zone should also be inside an active work-area polygon. If not, one subsystem says "staged" while another says "outside work area", which can cause passive demotion, stale presence, and confusing UI.

## Runtime behavior

If the background task detects an active staging zone at the current GPS point, staging wins for that tick even when `insideWorkArea = false`.

The debug panel records:

- `detectedZoneId`
- `detectedZoneName`
- `insideWorkArea`
- `decision reason = staging_zone_overrode_work_area_outside`

This keeps the driver staged and keeps the heartbeat alive, but it is a defensive runtime guard. The admin map should still be fixed so the staging zone sits inside an active work area.

## SQL inventory checks

List active work areas:

```sql
select id, name, active, updated_at
from work_areas
where active = true
order by name;
```

List active driver-visible staging zones and their polygon availability:

```sql
select id,
       name,
       active,
       visible_to_drivers,
       is_coming_soon,
       lat,
       lng,
       drawn_polygon is not null as has_drawn_polygon,
       driven_polygon is not null as has_driven_polygon,
       use_driven_polygon
from staging_zones
where active = true
  and visible_to_drivers = true
  and coalesce(is_coming_soon, false) = false
order by name;
```

Check the specific test zone:

```sql
select id,
       name,
       active,
       visible_to_drivers,
       is_coming_soon,
       lat,
       lng,
       drawn_polygon,
       driven_polygon,
       use_driven_polygon
from staging_zones
where id = '<zone_id>';
```

If PostGIS is enabled and polygons are stored as GeoJSON, this query can flag zone centers outside every active work area:

```sql
with active_zones as (
  select id, name, lng, lat
  from staging_zones
  where active = true
    and visible_to_drivers = true
    and coalesce(is_coming_soon, false) = false
),
active_work_areas as (
  select id, name, polygon
  from work_areas
  where active = true
)
select z.id as zone_id,
       z.name as zone_name,
       z.lat,
       z.lng
from active_zones z
where not exists (
  select 1
  from active_work_areas wa
  where st_contains(
    st_setsrid(st_geomfromgeojson(wa.polygon::text), 4326),
    st_setsrid(st_makepoint(z.lng, z.lat), 4326)
  )
)
order by z.name;
```

If PostGIS is not enabled, use the admin map or a Turf-based script to test each staging-zone polygon/center against the active work-area polygon.

## Expected after admin cleanup

- `insideWorkArea = yes` while standing inside every airport staging zone.
- `detectedZoneId` matches the staging zone.
- `decision reason = staging_zone_detected_inside_work_area`.
- Redux and Supabase both show `staged` with matching zone ids.
- `driver_presence.last_ping_at` stays under 90 seconds old.
