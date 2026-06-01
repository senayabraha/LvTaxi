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
