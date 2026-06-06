# Debug Field Testing

Use the admin dev-only Tracking Debug panel on a real phone to compare local Redux/runtime state with Supabase live-count state.

## How to open it

1. Sign in with an admin account on a development build.
2. Open Profile.
3. Scroll to Tracking Debug (dev admin).
4. Tap Refresh while standing in the staging area to fetch the current driver's database rows.

The panel is intentionally hidden from normal users and hidden outside `__DEV__`.

## Field meanings

- Redux `status`: local driver state, such as `passive_far`, `active`, or `staged`.
- Redux `currentZoneId`: local zone id used by UI "You are here" state.
- Redux `isInsideZone` / `zoneEntryTime`: local zone-entry flags from the driver slice.
- `trackingEnabled`: local master tracking switch.
- Current GPS lat/lng and accuracy: latest foreground Redux location.
- Passive/active task running: whether Expo reports each background task as started.
- Last passive/active run: last time that background task processed a location.
- Last background location: latest background task GPS point.
- `insideWorkArea`: background task polygon result.
- `workAreaPolygonCount`: number of active work-area polygons loaded into the background geometry cache.
- `detectedZoneId` / `detectedZoneName`: staging zone detected by background polygon logic.
- `desiredStatus`: status the last background task calculated.
- `decision reason`: why the background task chose that status, including `staging_zone_overrode_work_area_outside`.
- Status before/after: Redux status around the last background task decision.
- Transition source/payload: the last centralized transition helper call and the status/zone payload it intended.
- Exit grace fields: when exit grace started and how many minutes remain.
- Heartbeat attempt/success: latest presence heartbeat decision and latest successful write.
- Heartbeat blocked reason: why no heartbeat was written, such as `blocked_status_not_heartbeat`, `blocked_no_coordinates`, `blocked_throttle`, or `rpc_error`.
- Requested tracking / tracking after transition: whether the latest status transition requested active or passive OS tracking.
- Active/passive start/stop requested and errors: whether Expo task switching was requested and whether it failed.
- Supabase drivers: current signed-in driver's `drivers` row.
- Supabase presence: current signed-in driver's `driver_presence` row.
- Count eligibility: whether `active_driver_presence` includes this driver and how many fresh `active_driver_presence` rows exist for the relevant zone.

## Expected at Terminal 1 when staged correctly

- Redux `status = staged`
- Redux `currentZoneId = <terminal_1_zone_id>`
- Redux `isInsideZone = yes`
- `insideWorkArea = yes`
- `workAreaPolygonCount > 0`
- `detectedZoneId = <terminal_1_zone_id>`
- `detectedZoneName` is Terminal 1
- Last heartbeat blocked reason is `success` or the last success time is recent
- Supabase `drivers.status = staged`
- Supabase `drivers.current_zone_id = <terminal_1_zone_id>`
- Supabase `driver_presence.current_zone_id = <terminal_1_zone_id>`
- Supabase `driver_presence.classification = STAGING`
- Supabase `driver_presence.last_ping_at` is less than 90 seconds old
- `active_presence row = yes`
- `zone cars_staged = 1` or greater

## Values that confirm the known bug

- Redux `status = passive_far` or `passive_near` while Redux `currentZoneId` is Terminal 1.
- Supabase `drivers.status` remains passive while `driver_presence` is missing or stale.
- Heartbeat blocked reason is `blocked_status_not_heartbeat`.
- `driver_presence.current_zone_id` is null or not Terminal 1.
- `driver_presence.classification` is not `STAGING`.
- `driver_presence.last_ping_at` is older than 90 seconds.
- `active_presence row = no`.
- `zone cars_staged = 0` while the zone card says "You are here".
- `workAreaPolygonCount = 0`, which means the app could not positively decide that the driver is inside the work area.
- `insideWorkArea = no` while physically in Terminal 1 staging, which points to work-area polygon coverage or GPS accuracy.

## Samsung A Test 1 diagnosis

The real-device trace showed the app could stage and write presence, but a later background tick decided:

- `insideWorkArea = no`
- `detectedZoneId = A Test 1`
- `desiredStatus = passive_far`
- status before `staged`, status after `passive_far`

That means the staging-zone polygon matched the GPS point, but the work-area polygon did not. The fixed runtime rule is that a detected active staging zone wins for that tick. The debug panel should now show `decision reason = staging_zone_overrode_work_area_outside` instead of demoting to passive.

If this reason appears, the app is protecting the live queue, but admin data still needs cleanup: the staging zone should be inside an active work-area polygon.

## Queue position note

The previous position number came from historical `zone_visits`, which can include stale open visits after missed exits. The app now hides the position number until live queue ordering is derived from fresh presence rows. Seeing no `Position #` is expected for now.

## Active task running + heartbeat success + DB presence stale

If the debug panel shows all three of:

- `active task running = yes`
- `heartbeat last success` is recent (within the last 90 seconds)
- `Supabase driver_presence.last_ping_at` is older than 90 seconds

then the app is marking heartbeat as "success" without confirming that the DB row was actually refreshed.

Root causes to check in order:

1. **RPC returning void (pre-migration 018)** — The old `upsert_driver_presence` returned `void`, so `{ error: null }` was always returned whether the row was written or not. Deploy migration 018 to make the RPC return the written `last_ping_at`. The panel will then show `db ping confirmed fresh = yes/no` and `db mismatch reason` if stale.

2. **Ownership check failing silently** — Migration 012 added `IF p_driver_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION`. In background tasks, `auth.uid()` may return a different value if the Supabase client JWT is expired or not re-hydrated. The RPC raises an exception which PostgREST converts to a non-2xx response; the Supabase JS client surfaces this as `{ error: ... }`. Check `rpc error` in the debug panel Heartbeat section — it will be non-null if this is the cause.

3. **Session expired in background** — The Supabase JS client auto-refreshes the session while the app is in the foreground. In background tasks the refresh may not occur. If `rpc error` mentions "JWT expired" or "invalid claim", the session is stale. Ensure `supabase.auth.startAutoRefresh()` is called or that the session is manually refreshed before calling the RPC.

4. **Throttle interval too long relative to TTL** — `PRESENCE_HEARTBEAT_INTERVAL_MS` (~25s) must stay well below the 90s TTL. If the throttle is accidentally set higher (e.g. 120s), presence will expire between writes. Check `constants.js`.

Debug panel fields that confirm this diagnosis:

- `rpc started` / `rpc finished`: verifies the RPC was actually called
- `rpc error`: non-null means the RPC returned an error (ownership check, JWT, etc.)
- `rpc returned ping`: the `last_ping_at` the DB wrote — should match the current time
- `db ping confirmed fresh`: `yes` means the returned timestamp is within 90s; `no` means something is wrong
- `db mismatch reason`: human-readable explanation of why freshness check failed
- Warning banner: "Heartbeat reports success but DB presence is stale" — shown when `lastHeartbeatSuccessAt` is recent but the polled `driver_presence.last_ping_at` is older than 90s

SQL verification after fixing:

```sql
-- Run while a driver is staged and active task is running.
-- last_ping_at should update every ~25 seconds.
SELECT driver_id, current_zone_id, classification, last_ping_at, now() - last_ping_at AS age
FROM driver_presence
ORDER BY last_ping_at DESC
LIMIT 5;

-- Confirm the driver appears in the live-count view.
SELECT * FROM active_driver_presence WHERE driver_id = '<your-driver-uuid>';
```

## Staged but heartbeat goes stale

If the app shows:

- Redux `status = staged`
- Redux `currentZoneId` is set
- Supabase `driver_presence.classification = STAGING`
- `active task running = no`
- `passive task running = yes`
- heartbeat success is older than 90 seconds

then the staged transition succeeded but the OS tracking mode did not switch to active. The expected fix is:

- `requested tracking = active`
- `tracking after transition = active`
- `active start requested` is recent
- `active start error = -`
- `passive stop error = -`
- active task starts producing fresh `last active run` timestamps
- heartbeat success refreshes about every 25 seconds while staged
