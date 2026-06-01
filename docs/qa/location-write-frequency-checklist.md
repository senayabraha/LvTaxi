# QA Checklist — Location Write Frequency (Phase 2)

Goal: prove that GPS acquisition stays accurate and frequent on-device while
**backend writes to Supabase are reduced and structured**. The three concepts
are intentionally decoupled:

| Concept | Where | Frequency |
| --- | --- | --- |
| GPS acquisition (local read) | `locationEngine.js` | up to ~1/sec in HIGH mode |
| Presence heartbeat (Supabase write) | `presenceHeartbeat.js` | ~every 25s (`PRESENCE_HEARTBEAT_INTERVAL_SECONDS`) |
| Trajectory persistence (Supabase write) | `visitProcessor.js` at zone exit | once per visit |

Current behaviour (audited Phase 2): raw GPS points are **buffered in memory**
during a visit and written **once** at zone exit (Option A). There are **no
per-point Supabase writes**.

---

## 1. GPS acquisition vs heartbeat

- [ ] Go on duty, enter HIGH mode, leave the app running ~2 minutes.
- [ ] Confirm GPS fixes happen frequently (dev log `[locationWritePolicy] gpsFixes=...`
      climbs quickly; ~1/sec while moving).
- [ ] In Supabase, confirm `driver_presence.last_ping_at` for this driver updates
      roughly every **25 seconds**, NOT every second.

## 2. No per-point writes

- [ ] Stage inside a zone for ~3 minutes.
- [ ] Confirm Supabase does **not** receive one `trajectories` (or `gps_points`)
      write per second.
- [ ] Confirm exactly one `trajectories` row appears for the visit, written at
      **zone exit** (or via a controlled batch, never per point).
- [ ] Confirm `presenceWrites` in the dev log is far smaller than `gpsFixes`.

## 3. Visit classification still works

- [ ] Enter a staging zone and wait several minutes, then exit.
- [ ] Confirm `zone_visits.dwell_seconds` is saved.
- [ ] Confirm `trajectories.gps_points` for the visit contains a useful set of
      points (entry + exit endpoints present).
- [ ] Confirm classification ran (`zone_visits.classification` /
      `trajectories.ai_classification` populated).

## 4. Buffer limit

- [ ] Simulate / perform a long visit (well over `TRAJECTORY_MAX_BUFFER_POINTS`
      = 300 fixes).
- [ ] Confirm the in-memory buffer does not grow unbounded (it downsamples the
      middle while keeping first/last points).
- [ ] Confirm the app does not crash or run out of memory.

## 5. Offline scenario

- [ ] Start a visit online.
- [ ] Disable the network (airplane mode).
- [ ] Continue moving inside/through the zone.
- [ ] Exit the zone while still offline.
- [ ] Confirm the app does **not** crash; the trajectory write fails gracefully
      and is queued (`[visitProcessor] trajectory persist failed, queuing`).
- [ ] Re-enable the network and relaunch (or wait for the next launch).
- [ ] Confirm the queued trajectory is retried and persisted
      (`retryPendingTrajectories`), then dequeued from AsyncStorage.

## 6. Driver UI

- [ ] Confirm normal live rows still show cars, flow, wait range, confidence,
      and freshness.
- [ ] Confirm stale data shows the muted/red "Data stale" freshness label.
- [ ] Disable network and confirm `ConnectionBanner` shows
      "Reconnecting… · Live data may be delayed · Using cached zone data".
- [ ] Confirm there is **no** confusing raw-GPS / trajectory-upload status shown
      to drivers anywhere.

## 7. Write frequency ratio

- [ ] In dev logs, confirm the periodic line shows GPS fixes ≫ presence writes ≥
      trajectory flushes, e.g.:

  ```
  [locationWritePolicy] gpsFixes=120 presenceWrites=4 trajectoryFlushes=1
  ```

- [ ] Confirm these logs only appear in development (`__DEV__`), not production.

---

### Acceptance

- [ ] GPS may be ~1/sec while backend writes are much lower.
- [ ] No per-point Supabase writes for raw GPS.
- [ ] Buffer is bounded; long visits do not crash.
- [ ] Offline visits are retried or clearly logged.
- [ ] Driver UI stays simple; freshness + offline/delayed state are visible.

---

## Phase 2.1 — offline retry hardening

Dev-only observability for these tests comes from `[offlineRetry] …` logs
(`offlineRetryManager` → `offlineQueueDiagnostics`) and `[locationWritePolicy] …`.

### 2.1.1 Reconnect retry (no restart)

- [ ] Start a visit online.
- [ ] Disable the network (airplane mode).
- [ ] Exit the zone so the trajectory save fails and queues
      (`trajectory persist failed, queuing`).
- [ ] Re-enable the network **without restarting the app**.
- [ ] Confirm within a couple seconds a `[offlineRetry] reason=reconnect …` line
      appears and `pendingTrajectories` drops to 0.

### 2.1.2 Launch retry still works

- [ ] Queue a pending trajectory (exit offline).
- [ ] Kill the app completely.
- [ ] Relaunch while online.
- [ ] Confirm `[offlineRetry] reason=startup-online …` runs and the queue clears.

### 2.1.3 Classification side-effect queue

- [ ] Force a Supabase failure during `saveClassificationSafe` (offline at exit).
- [ ] Confirm a `SAVE_CLASSIFICATION` side effect is queued
      (`pendingSideEffects` > 0).
- [ ] Restore the network.
- [ ] Confirm retry re-applies `zone_visits.classification` /
      `trajectories.ai_classification` and the side effect is removed.

### 2.1.4 Load-event side-effect queue

- [ ] Force a failure during `recordLoadEventSafe` for a staging visit.
- [ ] Confirm a `RECORD_LOAD_EVENT` side effect is queued.
- [ ] Restore the network.
- [ ] Confirm retry records the departure/load event and clears the queue.

### 2.1.5 Driver history queue

- [ ] Force a failure during the `driver_zone_history` upsert.
- [ ] Confirm an `UPSERT_DRIVER_HISTORY` side effect is queued.
- [ ] Restore the network.
- [ ] Confirm retry updates `driver_zone_history` and clears the queue.

### 2.1.6 No high-frequency writes

- [ ] Run the app in HIGH mode for 2 minutes.
- [ ] Confirm GPS fixes are frequent, presence writes stay ~every 25s, and
      trajectory writes are still once per visit.
- [ ] Confirm side-effect retries happen only on launch / reconnect / failure —
      never on every GPS fix.

### 2.1.7 Recording async cleanup

- [ ] Enter one zone, then quickly enter another (or rapidly restart recording).
- [ ] Confirm no stale buffer leaks across visits and exactly one trajectory row
      is written per visit (no duplicate write).

### Phase 2.1 acceptance

- [ ] Pending trajectories retry on reconnect without an app restart.
- [ ] Failed classification / load-event / history writes queue and replay.
- [ ] Queues are bounded (≤20 trajectories, ≤50 side effects) and side-effect
      records carry no GPS arrays.
- [ ] Retries stop early on continued failure (no Supabase hammering).
- [ ] Presence still clears immediately when possible; otherwise the 90s TTL
      handles it.
- [ ] Driver-facing UI is unchanged and exposes no queue internals.
