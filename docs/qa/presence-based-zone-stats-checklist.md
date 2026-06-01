# Presence-Based Zone Stats — QA Checklist

Manual verification for the staging-architecture hardening (continuous presence
heartbeat, removal of legacy counters, wait sorting, RPC security, median-dwell
casing, off-duty clear, and stat-merge hardening).

There is no automated test runner in this repo (no `test` script / jest), so
these are SQL + in-app manual checks. Run the SQL in the Supabase SQL editor as
the relevant role.

Key references:
- TTL: `PRESENCE_TTL_SECONDS = 90` (`src/lib/constants.js`)
- Heartbeat: `PRESENCE_HEARTBEAT_INTERVAL_SECONDS = 25` (`src/lib/constants.js`)
- Heartbeat logic: `src/lib/presenceHeartbeat.js`
- Live stats RPC: `get_zone_live_stats()` (migration `012`)

---

## 1. Presence heartbeat keeps a staged driver counted past the TTL

1. On a real device, go on duty and tap **I'm Staging** in a zone.
2. Keep the app foregrounded for ~3 minutes.
3. In Supabase, watch the row:
   ```sql
   select driver_id, current_zone_id, classification,
          last_ping_at, now() - last_ping_at as age
   from driver_presence
   where driver_id = '<DRIVER_UUID>';
   ```
   - `last_ping_at` should advance roughly every ~25 s (heartbeat interval),
     not every 1 s, and not stay frozen at the initial stage time.
4. Confirm the driver stays in the live count beyond 90 s:
   ```sql
   select * from active_driver_presence where driver_id = '<DRIVER_UUID>';
   select cars_staged from get_zone_live_stats() where zone_id = '<ZONE_UUID>';
   ```
   - Driver remains in `active_driver_presence`; `cars_staged` stays ≥ 1.

**Pass:** heartbeat writes are throttled (~25 s) and the staged driver does not
expire while the app keeps updating.

---

## 2. TTL expiry removes a driver who stops updating

1. With the driver staged and counted, stop location updates (kill the app /
   disable location) so no more heartbeats are sent.
2. Wait > 90 s, then:
   ```sql
   select * from active_driver_presence where driver_id = '<DRIVER_UUID>';
   select cars_staged from get_zone_live_stats() where zone_id = '<ZONE_UUID>';
   ```
   - Driver is **gone** from `active_driver_presence`.
   - `cars_staged` has decreased by one.

**Pass:** a driver whose pings stop expires from the live count after the TTL.

---

## 3. Off-duty clears presence immediately

1. Driver is staged and counted (`cars_staged` ≥ 1).
2. Tap the status toggle to **Off Duty** (`StatusToggle` / `DriverToggle`).
3. Immediately (no 90 s wait):
   ```sql
   select current_zone_id, classification from driver_presence
   where driver_id = '<DRIVER_UUID>';
   select cars_staged from get_zone_live_stats() where zone_id = '<ZONE_UUID>';
   ```
   - `current_zone_id` is `NULL`, `classification` is `ACTIVE`.
   - The driver no longer contributes to `cars_staged`.

**Pass:** off-duty drops out of counts at once via `clearDriverPresence()`.

---

## 4. Derived count reflects only fresh presence rows

Run as a role allowed to write the rows (or seed via the app). Using two test
drivers in the same zone:

```sql
-- Two fresh rows in the same zone.
select upsert_driver_presence('<DRIVER_A>', '<ZONE_UUID>', 'STAGING', 36.10, -115.17);
select upsert_driver_presence('<DRIVER_B>', '<ZONE_UUID>', 'STAGING', 36.10, -115.17);
select cars_staged from get_zone_live_stats() where zone_id = '<ZONE_UUID>'; -- expect 2

-- Age one row beyond the TTL.
update driver_presence set last_ping_at = now() - interval '120 seconds'
where driver_id = '<DRIVER_A>';
select cars_staged from get_zone_live_stats() where zone_id = '<ZONE_UUID>'; -- expect 1
```

**Pass:** `cars_staged` counts only rows within the 90 s TTL.

---

## 5. Median dwell is casing-robust

```sql
-- Mixed-case completed staging visits in the same zone (dwell within 2–120 min).
insert into zone_visits (driver_id, zone_id, entered_at, exited_at, dwell_seconds, classification)
values
  ('<DRIVER_A>', '<ZONE_UUID>', now() - interval '20 min', now() - interval '10 min', 600, 'staging'),
  ('<DRIVER_B>', '<ZONE_UUID>', now() - interval '20 min', now() - interval '8 min',  720, 'STAGING');

select median_dwell_minutes, dwell_sample_size
from get_zone_live_stats() where zone_id = '<ZONE_UUID>';
```

- `dwell_sample_size` should be **2** (both casings counted).
- `median_dwell_minutes` is non-null (~11 min).

**Pass:** `lower(classification) = 'staging'` picks up both `staging` and
`STAGING`.

---

## 6. Zero-movement zone shows no Infinity/NaN

1. Create a zone with fresh staged cars but **no** recent `zone_departures` and
   no recent completed staging visits (no dwell samples).
2. ```sql
   select cars_staged, estimated_wait_minutes, wait_status, wait_confidence
   from get_zone_live_stats() where zone_id = '<ZONE_UUID>';
   ```
   - `estimated_wait_minutes` is `NULL`, `wait_status` = `NO_RECENT_MOVEMENT`.
3. In the app, the zone row renders "No recent movement" — never `Infinity`,
   `NaN`, or a bogus number (`ZoneListItem.formatWaitRange`).

**Pass:** missing movement data is surfaced as a label, not a broken number.

---

## 7. Wait sorting uses the new estimate

Setup two zones (others without estimates):
- Zone A: `estimated_wait_minutes = 10`, `wait_status = OK`.
- Zone B: `estimated_wait_minutes = 30`, `wait_status = OK`.
- Zone C: `wait_status = NO_RECENT_MOVEMENT`.

In the app, switch the sort to **Wait**:
- Zone A appears above Zone B.
- Zone C (no usable estimate) sorts to the bottom, not the top.

This is enforced by `getWaitSortValue()` in `src/lib/geofenceEngine.js`, used by
both `getTop20Zones()` and `HomeScreen` list sorting.

**Pass:** displayed wait range and ordering agree; no-data zones don't masquerade
as the best wait.

---

## 8. RPC security — drivers cannot spoof another driver

As authenticated **User A** (JWT `auth.uid()` = A):

```sql
-- Own row → succeeds.
select upsert_driver_presence(auth.uid(), '<ZONE_UUID>', 'STAGING', 36.10, -115.17);

-- Another driver's row → must raise.
select upsert_driver_presence('<DRIVER_B>', '<ZONE_UUID>', 'STAGING', 36.10, -115.17);
-- ERROR: Cannot upsert presence for another driver

-- Clearing another driver → must raise.
select clear_driver_presence('<DRIVER_B>');
-- ERROR: Cannot clear presence for another driver

-- Clearing own row → succeeds.
select clear_driver_presence(auth.uid());
```

Also confirm an invalid classification is normalized, not an error:
```sql
select upsert_driver_presence(auth.uid(), '<ZONE_UUID>', 'garbage', 36.10, -115.17);
select classification from driver_presence where driver_id = auth.uid(); -- 'ACTIVE'
```

**Pass:** ownership is enforced for both `upsert_driver_presence` and
`clear_driver_presence`; bad classification normalizes to `ACTIVE`.

---

## 9. Legacy realtime rows don't erase live fields

1. Load the zone list so live RPC populates `estimated_wait_*`, `wait_confidence`,
   etc. (visible wait range in the UI).
2. Trigger a `zone_stats` UPDATE that lacks the enriched columns (e.g. legacy
   counter path or a manual `update zone_stats set cars_staged = ...`).
3. Observe the realtime update flash the row but **not** revert the wait range to
   the legacy `wait_time_minutes`.

Enforced by `updateZoneStat` in `src/store/zonesSlice.js`, which preserves
existing enriched fields when an incoming row omits them.

**Pass:** the UI keeps the rich wait range/confidence; no flicker back to legacy
values.

---

## 10. No live flow calls legacy counters

Static check — these should return only the deprecated definitions in
`zoneStatsEngine.js`, with **no** app call sites:

```sh
grep -rn "incrementZoneCount(\|decrementZoneCount(" src/ | grep -v zoneStatsEngine.js
# (expect no output)
```

**Pass:** live counts come solely from `active_driver_presence` /
`get_zone_live_stats()`.
