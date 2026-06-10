# Geofence and Zone Model Analysis

Analysis-only documentation. No code or migration changes are made here.

## 1. Core model

LV Taxi uses two different geospatial concepts:

| Concept | Purpose | Source table | Effect |
|---|---|---|---|
| Work area | Broad polygon where automatic driver participation is allowed. | `work_areas` | Determines passive vs active/staged eligibility. |
| Staging zone | Exact taxi queue/staging area. | `staging_zones` | Determines `staged`, `current_zone_id`, and live queue count. |

A driver should not become automatically active/staged unless the driver is inside an active work-area polygon. A driver should not count in a queue unless the driver is inside a valid staging-zone polygon and writes fresh presence.

## 2. Staging-zone geometry fields

| Field | Meaning | Risk |
|---|---|---|
| `lat`, `lng` | Zone center for display, distance sorting, native circles, and fallback. | Center may not match actual queue geometry. |
| `radius_meters` | Native geofence circle radius / fallback radius. | Circle is not precise enough for taxi lanes. |
| `circle_enabled` | Whether to register native circle geofence. | Disabled zones may not wake the app. |
| `drawn_polygon` | Admin-drawn authoritative area. | Bad drawings cause missed staging. |
| `driven_polygon` | Geometry derived from driven route/capture. | May be more accurate but must be validated. |
| `use_driven_polygon` | Chooses driven over drawn polygon. | Wrong flag can silently select wrong geometry. |
| `active` | Enables zone operationally. | Active test zones can pollute production. |
| `is_coming_soon` | Placeholder zone flag. | Must be excluded from geofences/counts/UI active list. |
| `visible_to_drivers` | Driver-facing visibility. | `get_zone_live_stats()` may include active zones even if not visible unless audited. |

## 3. Native geofence vs polygon verification

Native geofences are circular OS wake-up triggers. They are not the source of truth. The app should use them to wake up and then verify against the selected staging-zone polygon.

Current behavior:

- `geofenceEngine` registers top-20 zones with `lat/lng/radius_meters` when `circle_enabled !== false`.
- On enter, it verifies polygon if available.
- If no polygon exists, it trusts the circle.
- If polygon check fails, it retries every 10 seconds for up to 2 minutes before discarding.

`workAreaGeometry.detectStagingZoneFromPoint()` prefers polygon, then falls back to a 200m center radius only for zones without polygons.

## 4. Answers to specific questions

### 1. Can a staging zone exist outside a work area?

Yes, the schema does not inherently prevent it. The detection system expects work-area containment, but there is no documented database constraint guaranteeing every active staging zone is inside an active work area.

### 2. What happens if a driver is inside a staging zone but outside a work area?

The automatic background state machine should treat the driver as outside/passive/exit-grace because work-area polygon is the participation gate. The driver should not auto-stage or count. This can happen if the work-area polygon is too small or Terminal 1 staging lies outside it.

### 3. What happens if work area fails to load?

`isInsideWorkAreaPolygon()` returns false when no polygons are loaded. This is a safe false-negative: drivers will not be counted, but physically present drivers may remain passive.

### 4. What happens if staging-zone polygon is missing?

For polygon-less zones, detection can fall back to center/radius proximity. This is useful during setup but risky for production airport/hotel lanes. Admin health checks should flag active polygon-less zones.

### 5. What happens if native geofence circle fires but polygon check fails?

The entry is deferred and retried for up to 2 minutes. If still outside the polygon, no staging entry is completed.

### 6. What happens if polygon check passes while status is passive?

The correct behavior is to promote to `staged` before heartbeat. Current `geofenceEngine.completeHandleEnter()` explicitly does this. However, any code path that only sets `currentZoneId` while leaving passive will cause the heartbeat guard to block the count.

### 7. Are test zones like “A Test” or “New York, New York” active and polluting production?

This requires live Supabase data confirmation. The repository contains no static seed conclusion sufficient to prove current production state. Use the validation SQL below.

### 8. Are coming-soon zones excluded everywhere they should be?

Mostly but not perfectly guaranteed. `workAreaGeometry`, `tierManager`, `geofenceEngine.getTop20Zones`, and `ImStagingButton` exclude coming-soon zones. `useZones()` filters active and visible-to-drivers but does not explicitly exclude coming-soon in the query; the UI displays coming-soon separately if included. `get_zone_live_stats()` includes all active zones, not explicitly `visible_to_drivers` or `is_coming_soon = false` in the reviewed migration.

### 9. Are inactive zones excluded everywhere they should be?

Most mobile fetches query `active = true`. `workAreaGeometry` direct fallback queries active zones. `get_zone_live_stats()` filters `sz.active = true`. Admin tools still need validation for inactive visible/geofence conflicts.

### 10. Does zone sorting/filtering affect which geofences are registered?

Yes. Native geofence registration uses top-20 zones based on sort/distance/flow/wait. If Terminal 1 is not in the top 20 due to location, sort mode, stale stats, missing location, or coming-soon filtering, native geofence wake-up may not be registered. Background active/passive tasks still perform polygon detection from cached zones, so native geofence omission should not be the only detection path.

## 5. Validation SQL

### List active work areas

```sql
select id, name, active, polygon is not null as has_polygon, created_at
from work_areas
where active = true
order by name;
```

### List active staging zones

```sql
select id, name, active, visible_to_drivers, is_coming_soon,
       lat, lng, radius_meters, circle_enabled,
       drawn_polygon is not null as has_drawn_polygon,
       driven_polygon is not null as has_driven_polygon,
       use_driven_polygon
from staging_zones
where active = true
order by name;
```

### List active zones without polygons

```sql
select id, name, lat, lng, radius_meters
from staging_zones
where active = true
  and is_coming_soon = false
  and drawn_polygon is null
  and driven_polygon is null
order by name;
```

### List test-looking zones

```sql
select id, name, active, visible_to_drivers, is_coming_soon, created_at
from staging_zones
where name ilike '%test%'
   or name ilike '%demo%'
   or name ilike '%new york%'
   or name ilike '%sample%'
order by active desc, name;
```

### List coming-soon active conflicts

```sql
select id, name, active, visible_to_drivers, is_coming_soon
from staging_zones
where active = true and is_coming_soon = true;
```

### Find zones with both polygons but unclear selection

```sql
select id, name, use_driven_polygon,
       drawn_polygon is not null as has_drawn,
       driven_polygon is not null as has_driven
from staging_zones
where active = true
  and drawn_polygon is not null
  and driven_polygon is not null
order by name;
```

### Approximate zone/work-area containment check

If PostGIS is not enabled, exact SQL containment may not be possible. Export GeoJSON or use a server/admin validator. If PostGIS is available, add generated geometry checks in a controlled migration later.

## 6. Recommended admin system checks

- At least one active work area exists.
- Every active work area has valid polygon JSON.
- Every active, visible, non-coming-soon staging zone has valid selected geometry.
- Every active staging zone is inside an active work area.
- No active test-looking zones in production.
- No coming-soon zone is active/visible/countable.
- Zone polygon area is within reasonable bounds.
- Zone polygon does not self-intersect.
- Overlapping staging zones are flagged unless explicitly allowed.
- Terminal 1 and Terminal 3 have airport-specific geometry validations.
- Native circle radius covers approach/wake-up area but polygon covers actual staging lane.

## 7. Terminal 1 relevance

If Terminal 1 staging is outside the active work-area polygon, or if the work-area cache loaded zero polygons on the Samsung device, the app will keep the driver passive and block heartbeat. This is one of the most likely explanations for the reported Terminal 1 contradiction.
