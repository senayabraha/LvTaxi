# LV Taxi — Geofence & Zone Model Analysis

> Analysis-only. Work areas vs staging zones, hybrid detection, and validation SQL.

---

## 1. Two-layer model

- **`work_areas`** (migration `010_work_areas.sql`): broad polygon defining "the driver is working".
  Gates whether a driver can auto-upgrade to `active`/`staged`. Source of truth for passive vs working.
- **`staging_zones`**: the exact queue/staging areas (airport pits, hotel cab lines). A driver
  inside a staging-zone polygon (and on duty) is `staged` and **counted**.

A driver must be **inside a work area** to auto-stage; the staging-zone polygon then pinpoints the
queue.

## 2. Geometry fields & detection

`staging_zones` columns: `active`, `is_coming_soon`, `lat`/`lng`, `radius_meters`,
`circle_enabled`, `drawn_polygon`, `driven_polygon`, `use_driven_polygon`, `visible_to_drivers`.

**Hybrid detection (`geofenceEngine.js`):**
- Native geofence **circle** wakes the app: `applyGeofences` registers regions with `radius =
  radius_meters ?? radius ?? 80`, only for zones with `circle_enabled !== false`
  (`geofenceEngine.js:311-321`).
- On Enter, `verifyWithPolygon` refines using `use_driven_polygon ? driven_polygon : drawn_polygon`
  (`geofenceEngine.js:41-53`). **If no polygon exists, the circle is trusted** (returns true).
- If the polygon check fails, entry is **deferred** and retried every 10 s for up to 2 min before
  discarding (`handleEnter` retry loop, `:141-168`).
- Coming-soon zones are filtered before geofence registration (`getTop20Zones`, `:283`); only top-20
  by sort are registered (geofence slot limit).

## 3. Question-by-question

1. **Can a staging zone exist outside a work area?** Yes — there is no DB constraint linking
   `staging_zones` to `work_areas`. Nothing prevents a zone whose polygon lies outside every work
   area.
2. **Driver inside staging zone but outside work area?** Geofence circle may fire and set
   `currentZoneId`, but auto-promotion to `staged` requires `isInsideWorkAreaPolygon` true in the
   passive/active task. If outside the work area, the driver is kept passive → no heartbeat → not
   counted, even though "You are here" may show. (Directly relevant to the Terminal 1 bug.)
3. **Work area fails to load?** `isInsideWorkAreaPolygon` returns false → driver treated as outside
   → passive. **Fail-closed and silent.**
4. **Staging-zone polygon missing?** `verifyWithPolygon` trusts the circle (fail-open) → may
   over-count drivers merely near the circle.
5. **Native circle fires but polygon check fails?** Entry deferred/retried up to 2 min, then
   discarded; `completeHandleEnter` (and STAGED promotion) never runs.
6. **Polygon passes while status is passive?** `completeHandleEnter` calls `persistDriverStatus(STAGED)`
   before the forced heartbeat (`geofenceEngine.js:86`), so this path *does* promote. The risk is a
   later passive/reconcile write overriding it.
7. **Test zones active in production?** `zoneHealth.js` keys off `active`/`is_coming_soon` only —
   there is **no name-based test-zone filter**. A zone literally named "A Test" or "New York,
   New York" with `active=true` would register geofences and pollute counts. Must verify in DB.
8. **Coming-soon excluded everywhere?** Mostly: `getTop20Zones` (`:283`) and `get_zone_live_stats`
   (`WHERE sz.active = true`) exclude inactive; `useZones` filters `active AND visible_to_drivers`.
   But `get_zone_live_stats` filters on `active`, **not** `is_coming_soon` — a coming-soon zone with
   `active=true` would still get a row. Confirm the convention (coming-soon ⇒ `active=false`).
9. **Inactive zones excluded everywhere?** `active=false` is excluded from mobile list and RPC. OK.
10. **Does sorting/filtering affect which geofences register?** Yes — only the **top-20** by the
    current sort are registered (`getTop20Zones`/`applyGeofences`). A zone that falls outside the
    top-20 for the chosen sort gets **no geofence** until re-ranked. With ≤15 production zones today
    this is moot, but it is a scaling cliff.

## 4. Validation SQL

```sql
-- Active work areas
SELECT id, name, active FROM work_areas WHERE active = true;

-- Active staging zones (with geometry presence)
SELECT id, name, active, is_coming_soon, circle_enabled,
       radius_meters,
       (drawn_polygon IS NOT NULL)  AS has_drawn,
       (driven_polygon IS NOT NULL) AS has_driven, use_driven_polygon
FROM staging_zones
WHERE active = true
ORDER BY name;

-- Active zones with NO polygon (circle-only → fail-open detection)
SELECT id, name FROM staging_zones
WHERE active = true AND drawn_polygon IS NULL AND driven_polygon IS NULL;

-- Test-looking zones still active
SELECT id, name, active, is_coming_soon FROM staging_zones
WHERE active = true
  AND (name ILIKE '%test%' OR name ILIKE '%new york%' OR name ILIKE '%demo%' OR name ILIKE '%sample%');

-- Coming-soon but still active (should not happen)
SELECT id, name FROM staging_zones WHERE is_coming_soon = true AND active = true;

-- (Manual) zones whose center is outside all active work areas — requires PostGIS or
-- app-side point-in-polygon; jsonb polygons here are not geometry types.
```

## 5. Recommended admin system checks (proposed, not implemented)

- Each active zone has valid geometry (polygon or explicit circle).
- Each active zone's polygon is inside an active work area.
- At least one active work area exists and its polygon is non-degenerate.
- No active zones with test-looking names.
- Polygon area within sane bounds (not 0, not city-sized).
- No unintended overlapping zone polygons.
- Coming-soon ⇒ `active=false` invariant holds.

See `system-risk-register.md` (bad/test zones, missing work area) and `fix-roadmap.md` P1.
