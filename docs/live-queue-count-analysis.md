# LV Taxi — Live Queue Count Analysis

> Analysis-only. End-to-end trace from GPS to the "N cars" number, plus verification SQL.

---

## 1. The pipeline

```
GPS fix
 → driver status (drivers.status; gates heartbeat)
 → current zone (Redux currentZoneId; DB driver_presence.current_zone_id)
 → presence heartbeat (presenceHeartbeat.maybeSendPresenceHeartbeat, throttle 25s)
 → driver_presence row (last_ping_at, current_zone_id, classification)
 → active_driver_presence view (90s TTL + zone NOT NULL + classification in STAGING/UNKNOWN)
 → get_zone_live_stats() RPC (live_counts CTE → cars_staged)
 → useZones.fetchLiveZoneStats → dispatch(updateZoneStat) → zones.stats[zoneId]
 → ZoneListItem count display ("N cars")
 → admin DriversPage (separate read of driver_presence.last_ping_at)
```

---

## 2. Question-by-question

1. **Which exact DB row makes a driver count as "1 car"?** A `driver_presence` row
   (PK `driver_id`) with `last_ping_at > now()-90s`, `current_zone_id = <zone>`, and
   `classification IN ('STAGING','UNKNOWN')`. Count = `COUNT(DISTINCT driver_id)` over those rows
   grouped by `current_zone_id` (`012_...:130-139`).
2. **Does `drivers.status` matter for the count?** Not directly — the count query never reads
   `drivers.status`. It matters **indirectly**: `presenceHeartbeat.js:46` won't write presence
   unless status is `active`/`staged`, so status decides whether a counting row exists.
3. **Role of `driver_presence.classification`?** Filter. Only `STAGING` and `UNKNOWN` count.
   `ACTIVE`, `PASSING`, `DROP_OFF`, `EXIT_GRACE` are excluded. The client maps state→classification
   in `classificationForState` (`presenceHeartbeat.js:78-84`): staged or in-zone→`STAGING`;
   zone-but-unconfirmed→`UNKNOWN`; on-duty-no-zone→`ACTIVE` (with null zone, so excluded anyway).
4. **Role of `driver_presence.current_zone_id`?** Must be non-null and is the grouping key. A null
   zone (e.g. plain `active`) is excluded from every zone's count.
5. **Role of `last_ping_at` TTL?** Hard 90 s gate (`v_ttl interval := interval '90 seconds'`,
   `012_...:124`). A driver who stops heartbeating drops from counts after 90 s.
6. **After 90 s with no heartbeat?** Row excluded from `active_driver_presence` and `live_counts`;
   `cars_staged` decrements; `last_updated` (now()) keeps refreshing per call but the *count* falls.
7. **`active` with null zone?** Heartbeats (classification `ACTIVE`, null zone) → admin "online" but
   contributes to **no** zone count. Correct.
8. **`staged` but no `driver_presence` row?** Count = 0 for that driver. The UI may still show
   "You are here" (Redux), producing the contradiction. This is the Samsung pattern.
9. **`currentZoneId` set in Redux but presence missing?** UI shows zone/"You are here" and Position
   from `getDriverPositionInZone`, but `cars_staged=0`. No DB row ⇒ not counted.
10. **Zone card says "You are here" but `active_driver_presence` lacks the row?** Exactly the bug:
    Redux `currentZoneId` (UI truth) and DB presence (count truth) disagree.

---

## 3. SQL view + RPC logic (references)

- **View** `active_driver_presence` (`011_presence_based_zone_stats.sql:70`, reaffirmed
  `014_...:125`):
  `WHERE last_ping_at > now()-interval '90 seconds' AND current_zone_id IS NOT NULL
   AND classification IN ('STAGING','UNKNOWN')`.
- **RPC** `get_zone_live_stats()` `live_counts` CTE (`012_...:130-139`) replicates the same filter
  inline and computes `cars_staged = COUNT(DISTINCT driver_id)`.
- **Write** `upsert_driver_presence()` (`012_...:18-69`): SECURITY DEFINER, ownership-checked,
  normalizes unknown classification → `ACTIVE` (note: 012 whitelist omits `EXIT_GRACE`; added in
  `014`).

---

## 4. Frontend fetch + staleness

- `useZones` calls `fetchLiveZoneStats()` (→ `get_zone_live_stats` RPC; fallback `zone_stats`),
  polls every 30 s (`LIVE_POLL_INTERVAL_MS`), and subscribes to `zone_stats` realtime
  (`hooks/useZones.js:139-193`).
- `zonesSlice.updateZoneStat` preserves enriched fields when a legacy realtime row omits them
  (`zonesSlice.js:27-51`).
- `ZoneListItem` shows `cars_staged ?? 0` and a freshness label; > 90 s old → red "Data stale"
  (`ZoneListItem.jsx:94-102`). **Note:** the RPC always sets `last_updated = now()` (`012_...:206`),
  so "Data stale" really reflects the *client poll/realtime* not refreshing (no recent fetch), or
  the fallback `zone_stats.last_updated` being old — not the RPC itself.

---

## 5. Where the count can go wrong

| Failure point | Effect |
|---|---|
| Passive status blocks heartbeat | No presence row → 0 cars |
| Work-area gate false-negative | Forces passive → no heartbeat |
| `classification` normalized to ACTIVE | Row exists but excluded from count |
| `current_zone_id` null in presence | Excluded |
| Heartbeat throttle + TTL mismatch | OK by design (25 s < 90 s), but if writes fail repeatedly, drops |
| RPC fallback to `zone_stats` | Shows legacy cache count, may be stale/zero |
| Redux `currentZoneId` not cleared on passive | UI "You are here" with 0 count |
| Multiple writers race | status flips passive, count lost |

---

## 6. Verification checklist (driver inside Terminal 1)

Replace `:driver` and `:t1` with the driver UUID and Terminal 1 zone id.

```sql
-- Step A: drivers row
SELECT id, status, current_zone_id, tracking_enabled
FROM drivers WHERE id = :driver;
-- Expect: status='staged', current_zone_id=:t1

-- Step B: presence row + freshness
SELECT driver_id, current_zone_id, classification, last_ping_at,
       (now() - last_ping_at) AS age
FROM driver_presence WHERE driver_id = :driver;
-- Expect: current_zone_id=:t1, classification='STAGING', age < 90s

-- Step C: does the view include the driver?
SELECT * FROM active_driver_presence WHERE driver_id = :driver;
-- Expect: exactly one row for :t1

-- Step D: RPC count for T1
SELECT zone_id, cars_staged, wait_status, wait_confidence, last_updated
FROM get_zone_live_stats() WHERE zone_id = :t1;
-- Expect: cars_staged = 1

-- Step E: is there an active work area containing T1's center?
SELECT id, name, active FROM work_areas WHERE active = true;
-- (Then verify polygon contains the driver's lat/lng / T1 center.)

-- Step F: zone config sanity
SELECT id, name, active, is_coming_soon, circle_enabled,
       (drawn_polygon IS NOT NULL) AS has_drawn,
       (driven_polygon IS NOT NULL) AS has_driven, use_driven_polygon
FROM staging_zones WHERE id = :t1;
```

If A shows `passive_far`/null zone or B returns no row → confirms the heartbeat never wrote
(status gate). If E returns no active work area, or the polygon excludes T1 → confirms the
fail-closed work-area hypothesis (#1 in the state-machine doc).
