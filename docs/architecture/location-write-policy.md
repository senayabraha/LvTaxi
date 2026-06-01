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

## Phase 2.1 — offline retry hardening

Phase 2.1 hardens recovery of the existing per-visit writes **without** adding
any new high-frequency write path.

- **Retry on reconnect, not just launch.** `src/lib/offlineRetryManager.js`
  subscribes to NetInfo and, on an offline→online transition, schedules a single
  **debounced** (2s) retry pass. A `retryInFlight` guard prevents overlapping
  drains, so flapping connectivity cannot spam Supabase. It is started in
  `App.jsx` for the authenticated app and also drains queues on startup-online
  (preserving the launch-retry behaviour).
- **Trajectory persistence is separate from post-visit side effects.** Raw GPS
  arrays live only in the pending-**trajectory** queue
  (`lvtaxi:pending:trajectories:v1`). The post-visit side effects live in a
  separate, compact queue (`lvtaxi:pending:visit_side_effects:v1`) that never
  stores GPS arrays.
- **Atomic classification finalize (no cross-table window).** At zone exit,
  `finalizeVisitClassification()` writes BOTH `trajectories`
  (`ai_classification`/`ai_confidence`, plus `gps_points`/`features`) AND
  `zone_visits` (`classification`/`confidence_score`) in **one transaction** via
  the `finalize_visit_classification` RPC (migration `013`). Because both writes
  share a transaction, the two tables can never be momentarily out of sync. On a
  genuine offline/transient failure the single combined trajectory row is queued
  and its replay (`replayPendingTrajectory`) restores **both** tables together —
  via the same atomic RPC. If the RPC isn't deployed yet (pre-013), the code
  falls back to the legacy per-table writes (`persistTrajectorySafe` +
  `saveClassificationSafe`), and the replay path keeps `zone_visits` in step with
  a sequential update.
- **Classification ownership split (no duplicate writes).** Within the atomic
  RPC, `trajectories` owns `ai_classification`/`ai_confidence` and `zone_visits`
  owns `classification`/`confidence_score`. The fallback `SAVE_CLASSIFICATION`
  side effect owns only the `zone_visits` fields. Neither path writes the other's
  columns, so classification is never written to `trajectories` twice.
- **Queued side effects** (`offlineCache`, bounded to 50, de-duped by a stable
  `id`):
  - `SAVE_CLASSIFICATION` — re-applies `zone_visits.classification` /
    `confidence_score` **only** (trajectory classification is restored by the
    pending-trajectory replay, not here).
  - `RECORD_LOAD_EVENT` — replays `record_load_event(zoneId)` for flow calc.
  - `UPSERT_DRIVER_HISTORY` — replays the `driver_zone_history` upsert deltas.
- **Safe per-write wrappers** in `visitProcessor` (`persistTrajectorySafe`,
  `saveClassificationSafe`, `recordLoadEventSafe`, `upsertHistorySafe`,
  `clearPresenceSafe`) mean one failed side effect never aborts the rest of the
  exit and never crashes the app.
- **Presence clear is NOT queued.** A stale queued clear could later drop a
  driver who has since re-staged, so if the immediate clear fails we rely on the
  90-second presence TTL to expire the row instead.
- **Replay is bounded and polite.** `retryPendingTrajectories()` and
  `retryPendingVisitSideEffects()` process in queued order and **stop at the
  first still-failing write** to avoid hammering an offline backend; successful
  items are dequeued. Dev-only depth/result logging lives in
  `src/lib/offlineQueueDiagnostics.js`.
- **Recorder async cleanup.** `trajectoryRecorder.startRecording()` now resets
  state **synchronously** (`resetRecordingState`) instead of calling an
  unawaited async `stopRecording()`. `stopRecording()` is synchronous and never
  writes; the old `persist:true` fallback insert was removed so there is no
  duplicate-write or unawaited-persistence risk.

No new per-point writes were introduced, the ~25s presence heartbeat is
unchanged, and the future Redis/WebSocket/MQTT hot path remains separate.
