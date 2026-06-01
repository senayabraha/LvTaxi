# Location Write Policy (Phase 2)

This document exists so future developers do **not** accidentally reintroduce
per-point Supabase writes or drop the presence heartbeat to a Supabase-killing
3–5 seconds.

## The three decoupled concepts

LVTaxi deliberately separates three things that are easy to conflate:

1. **GPS acquisition** — how often the phone *reads* a fix.
   - `src/lib/locationEngine.js`, up to ~1/sec in HIGH mode
     (`Accuracy.BestForNavigation`, `timeInterval: 1000`).
   - This is a **local, on-device read**. It costs battery, not backend load.
   - Keep it accurate. Do **not** blindly reduce GPS accuracy to save writes.

2. **Live presence heartbeat** — how often Supabase hears "driver is still here".
   - `src/lib/presenceHeartbeat.js`, throttled to
     `PRESENCE_HEARTBEAT_INTERVAL_SECONDS` (**~25s**).
   - Sends a **tiny** row only: `driverId, zoneId, classification, lat, lng,
     speed, accuracy, heading, visitId`. **No point arrays.**
   - Refreshes `driver_presence.last_ping_at` so the driver stays inside the 90s
     live-count TTL (`PRESENCE_TTL_SECONDS`).
   - Live zone counts come from **presence** (`active_driver_presence` →
     `get_zone_live_stats()`), never from raw trajectory points and never from
     legacy increment/decrement counters.

3. **Raw trajectory persistence** — how raw GPS history is *saved* for analysis
   and visit classification.
   - Buffered in memory by `src/lib/trajectoryRecorder.js` during the visit.
   - Persisted **once per visit at zone exit** by
     `src/lib/visitProcessor.js` (`processZoneExit` → single
     `trajectories` upsert). **One visit = one write. Never one point = one
     write.**

## Buffering and bounds

- `trajectoryRecorder` appends each fix to an in-memory buffer
  (`appendTrajectoryPoint`), throttled to ~1 buffered point/sec.
- The buffer is hard-capped at `TRAJECTORY_MAX_BUFFER_POINTS` (300). When
  exceeded it downsamples the *middle* of the buffer while preserving the first
  and last points, so entry/exit features survive and memory can't grow
  unbounded.
- On exit the buffer is handed to `visitProcessor` and then cleared.

## Offline resilience

- If the single per-visit write fails (e.g. offline), the row is queued in
  AsyncStorage via `offlineCache.savePendingTrajectory` (bounded:
  ≤20 saves, ≤300 points each, points simplified).
- `visitProcessor.retryPendingTrajectories()` runs on app launch (and is safe to
  call on reconnect) to flush the queue, dequeuing each on success.

## Do NOT

- Do **not** write every GPS point individually to Supabase.
- Do **not** subscribe clients to raw trajectory/GPS changes via Supabase
  Realtime (firehose).
- Do **not** lower the presence heartbeat to 3–5s while Supabase/Postgres is the
  live presence store.
- Do **not** put the trajectory buffer into the presence heartbeat payload.

## Future hot path (NOT current behaviour)

A 3–5 second live heartbeat is appropriate **only** for a future Redis /
WebSocket / MQTT hot path designed to absorb that write rate. It is **not**
appropriate for direct Supabase writes today. `TRAJECTORY_BATCH_FLUSH_INTERVAL_*`
and `flushTrajectoryBatch()` exist as scaffolding for an optional batch path
(Option B) but the current default is per-visit persistence (Option A).

## Dev verification

`src/lib/locationWritePolicy.js` keeps in-memory counters and logs (in `__DEV__`
only) a line like:

```
[locationWritePolicy] gpsFixes=120 presenceWrites=4 trajectoryFlushes=1
```

This makes the invariant visible: GPS reads ≫ presence writes ≥ trajectory
flushes.
