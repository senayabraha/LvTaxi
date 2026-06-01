# LvTaxi — Manual QA Checklist
# Presence-Based Zone Stats (migration 011)

Run these checks after applying migration 011 to Supabase and deploying the updated app.

---

## Pre-flight

- [ ] `supabase db push` (or paste migration SQL into Supabase SQL editor) completed without errors.
- [ ] `driver_presence` table exists in Supabase Table Editor.
- [ ] `active_driver_presence` view exists.
- [ ] `get_zone_live_stats` RPC exists and returns rows when called from the SQL editor:
      ```sql
      SELECT * FROM get_zone_live_stats();
      ```
- [ ] `upsert_driver_presence` and `clear_driver_presence` functions exist.
- [ ] `zone_stats` table has new columns: `estimated_wait_minutes`, `estimated_wait_min`,
      `estimated_wait_max`, `wait_confidence`, `wait_status`,
      `smoothed_service_rate_per_hour`, `median_dwell_minutes`, `dwell_sample_size`.

---

## Test 1 — Counter drift (self-healing presence)

**Goal:** A driver who stops pinging disappears from the live count after 90 seconds
         WITHOUT needing a geofence exit event.

Steps:
1. Have a test driver open the app and enter a staging zone. Confirm zone row shows cars = 1.
2. Kill the app process / disable GPS on that device.
3. Wait 90 seconds.
4. Pull down to refresh HomeScreen (or wait for the 30-second poll).
5. **Expected:** cars count drops back to 0. No manual exit event needed.

---

## Test 2 — Zero flow / no recent movement

**Goal:** A zone with staged cars but zero departures in 60 minutes does not show
         Infinity, NaN, or a blank wait.

Steps:
1. Ensure a zone has ≥1 car staged via driver_presence.
2. Delete or ignore zone_departures for that zone (or just use a fresh zone with no history).
3. Call `SELECT * FROM get_zone_live_stats()` or pull-to-refresh the app.
4. **Expected:**
   - `wait_status` = `NO_RECENT_MOVEMENT`
   - App shows "No recent movement" in the wait field.
   - No Infinity or NaN visible anywhere.

---

## Test 3 — Median dwell vs average

**Goal:** Median filters out outlier dwell times.

Steps (SQL):
```sql
-- Insert 5 synthetic completed staging visits for a test zone.
-- Dwell times: 18 min, 20 min, 22 min, 25 min, 90 min (outlier).
-- Average would be (18+20+22+25+90)/5 = 35 min.
-- Median should be 22 min.
SELECT * FROM get_zone_live_stats() WHERE zone_id = '<test_zone_id>';
```
4. **Expected:** `median_dwell_minutes` ≈ 22, not 35.

---

## Test 4 — Blended wait estimate

**Goal:** When both median dwell and queue wait exist, estimate is a weighted blend.

Steps (SQL):
1. Set up a zone with median_dwell ≈ 20 min and a smoothed_service_rate that gives
   queue_wait ≈ 15 min (e.g., cars=5, rate=20/hr → 5/(20/60)=15 min).
2. Expected: `estimated_wait_minutes` ≈ 0.65 × 20 + 0.35 × 15 = 18.25 min.
3. Run `SELECT estimated_wait_minutes FROM get_zone_live_stats() WHERE zone_id = '...'`.
4. **Expected:** value is between 15 and 20 (blended, not just one signal).

---

## Test 5 — Low sample confidence

**Goal:** Fewer than 4 recent dwell samples → confidence LOW or MEDIUM, never HIGH.

Steps (SQL):
```sql
-- Verify a zone with only 1–2 recent staging visits in the last 60 minutes.
SELECT dwell_sample_size, wait_confidence
FROM get_zone_live_stats()
WHERE zone_id = '<zone_with_few_visits>';
```
4. **Expected:** `wait_confidence` = `LOW` or `MEDIUM`, not `HIGH`.

---

## Test 6 — UI: Zone row displays wait range

Steps:
1. Open HomeScreen with a zone that has live data and >4 dwell samples.
2. **Expected:**
   - Wait field shows a range like "20–30 min", not a single "25 min".
   - A confidence label (e.g. "High confidence") appears below the main stats.
   - A freshness label (e.g. "Live" or "Updated 15s ago") appears.
3. For a zone with no recent movement:
   - Wait field shows "No recent movement".
   - Color is muted gray, not green/yellow/red.

---

## Test 7 — UI: "You are here" line uses wait range

Steps:
1. Have a driver enter a staging zone so the zone row shows the current-zone indicator.
2. **Expected:** The bottom line reads something like:
   `📍 You are here — Position #3 — Your wait: 20–30 min`
   (range, not single minute value).
3. If data is insufficient:
   `📍 You are here — Your wait: Not enough data`

---

## Test 8 — I'm Staging button writes presence

Steps:
1. Driver taps "I'm Staging" and confirms a zone.
2. Immediately query:
   ```sql
   SELECT * FROM driver_presence WHERE driver_id = '<driver_uuid>';
   ```
3. **Expected:**
   - `current_zone_id` = confirmed zone id.
   - `classification` = `STAGING`.
   - `last_ping_at` is within 5 seconds of now.
4. Wait 90+ seconds without the driver sending another ping.
5. Query `SELECT * FROM active_driver_presence` — the row should be gone.
6. `get_zone_live_stats()` should show cars_staged decreased by 1 for that zone.

---

## Test 9 — Backward compatibility

Steps:
1. Simulate a zone_stats row that has the old fields only (no estimated_wait_* columns).
2. Open HomeScreen — zone row should still render.
3. **Expected:** Wait field falls back to `~{wait_time_minutes} min` or `—`.
4. No crash. No blank screen.

---

## Test 10 — Analytics screen unaffected

Steps:
1. Open AnalyticsScreen.
2. **Expected:** "Time staged" and "Rides loaded" still show correct data.
3. "Best zones for you" list populates from zone_visits (unchanged).
4. Heatmap renders without errors.

---

## Manual TODO for you (owner)

1. **Apply migration to Supabase:**
   ```
   supabase db push
   ```
   or copy `supabase/migrations/011_presence_based_zone_stats.sql` into the
   Supabase SQL editor and run it.

2. **Wire GPS pings to `upsert_driver_presence`** in `src/lib/geofenceEngine.js`
   and/or the tier manager's GPS handler. Currently the geofence engine calls
   `incrementZoneCount` on enter — add a parallel call to `upsertDriverPresence`
   with the driver's GPS point and visit classification. On every subsequent
   smoothed GPS point while inside a zone, call `upsertDriverPresence` again
   to refresh `last_ping_at`.

3. **Wire zone exits to `clearDriverPresence`** in `src/lib/geofenceEngine.js`
   on the exit path (after `decrementZoneCount`). This gives instant cleanup
   on clean exits; the 90-second TTL handles crash/force-quit cases.

4. **Enable Supabase Realtime on `driver_presence`** (optional) if you want
   the zone list to flash on every GPS ping rather than only on `zone_stats` changes.
   Table Editor → driver_presence → Realtime → Enable.

5. **Remove `incrementZoneCount` / `decrementZoneCount` call sites** once
   you're satisfied the presence model is stable. They are now deprecated but
   kept to avoid breaking changes during migration.

6. **Consider a pg_cron job** to call `clear_driver_presence` for rows older
   than 5 minutes (belt-and-suspenders housekeeping):
   ```sql
   SELECT cron.schedule(
     'cleanup-stale-presence',
     '* * * * *',
     $$UPDATE driver_presence SET current_zone_id = NULL
       WHERE last_ping_at < now() - interval '5 minutes'
         AND current_zone_id IS NOT NULL;$$
   );
   ```
   This is optional — the 90-second TTL view is the correctness gate, not this job.
