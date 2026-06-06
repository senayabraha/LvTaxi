# Wait-Time and Flow Algorithm Analysis

Analysis-only documentation. This document describes the current wait/flow model and recommendations. No code changes are made here.

## 1. Current calculation path

```text
zone_visits
-> dwell_seconds + classification
-> zone_departures
-> flow_rate_per_hour / smoothed_service_rate_per_hour
-> median_dwell_minutes
-> cars_staged from live presence
-> estimated_wait_minutes/range
-> wait_confidence
-> wait_status
-> ZoneListItem
```

Live car count and wait estimate are assembled in `get_zone_live_stats()`.

## 2. Formula: `cars_staged`

Current formula:

```sql
count(distinct driver_id)
from driver_presence
where last_ping_at > now() - interval '90 seconds'
  and current_zone_id is not null
  and classification in ('STAGING', 'UNKNOWN')
group by current_zone_id
```

This is the correct source for live count. It does not use `zone_stats.cars_staged`.

## 3. Formula: `flow_rate_per_hour`

The RPC returns legacy `zone_stats.flow_rate_per_hour` as `flow_rate_per_hour`. The richer service-rate model is derived from `zone_departures`.

## 4. Formula: smoothed service rate

The current smoothed rate blends three departure windows:

```text
rate_15m = departures in last 15 minutes * 4
rate_30m = departures in last 30 minutes * 2
rate_60m = departures in last 60 minutes

smoothed_service_rate_per_hour =
  0.50 * rate_15m + 0.30 * rate_30m + 0.20 * rate_60m
```

Interpretation: recent movement matters most, but longer windows stabilize the estimate.

## 5. Formula: median dwell

Current dwell sample:

```sql
completed zone_visits
where exited_at is not null
  and dwell_seconds between 120 and 7200
  and lower(classification) = 'staging'
  and exited_at > now() - interval '60 minutes'
```

Formula:

```text
median_dwell_minutes = percentile_cont(0.5) over dwell_seconds / 60
```

## 6. Formula: queue-based wait

```text
queue_wait_minutes = cars_staged / (smoothed_service_rate_per_hour / 60)
```

Only calculated when `smoothed_service_rate_per_hour >= 1.0`.

## 7. Formula: final estimated wait

```text
if median_dwell and queue_wait both exist:
  estimated_wait = 0.65 * median_dwell + 0.35 * queue_wait
else if median_dwell exists:
  estimated_wait = median_dwell
else if queue_wait exists:
  estimated_wait = queue_wait
else:
  null
```

Wait range:

- Under 10 minutes: ±3 minutes.
- 10–30 minutes: ±5 minutes.
- 30–60 minutes: ±10 minutes.
- Over 60 minutes: ±15 minutes.

## 8. Confidence rules

Current rules:

- `HIGH`: sample size >= 10, median and queue wait exist, smoothed rate >= 2/hr, and median vs queue wait differ by <= 15 minutes.
- `MEDIUM`: sample size 4–9, or only one of median/queue wait exists.
- `LOW`: sample size 1–3, or smoothed rate < 1/hr.
- `INSUFFICIENT_DATA`: no usable estimate.

## 9. Wait status rules

- `INSUFFICIENT_DATA`: no estimate and zero staged cars.
- `NO_RECENT_MOVEMENT`: no estimate but cars staged > 0.
- `OK`: usable estimate exists.

The table constraint also allows `STALE` and `DEGRADED`, but the reviewed RPC currently emits mostly `INSUFFICIENT_DATA`, `NO_RECENT_MOVEMENT`, and `OK`.

## 10. Why UI shows “Not enough data”

The UI shows “Not enough data” when `wait_status = INSUFFICIENT_DATA`. This usually means there are no live staged cars and no usable recent dwell/departure history.

## 11. Why UI shows “Data stale”

The zone card freshness label uses the stat row timestamp. If live RPC polling fails and cached/legacy stats are used, the displayed `last_updated` can age past the 90-second TTL and show “Data stale.” Because `get_zone_live_stats()` returns `now()` as `last_updated`, a healthy RPC poll every 30 seconds should not show stale.

## 12. One-driver testing impact

With one tester:

- `cars_staged` can be correct as 1 if heartbeat works.
- Wait estimate may remain `NO_RECENT_MOVEMENT` if no departure event exists.
- `median_dwell_minutes` requires completed staging visits with classification `staging`.
- Confidence should be low or insufficient until enough completed visits and departures accumulate.

Therefore, a one-driver test can validate live count and heartbeat, but cannot fully validate wait-time quality.

## 13. Data required before wait estimates are meaningful

Minimum recommended practical data per zone:

- At least 10 completed staging visits in the last rolling window.
- At least 2 departures/hour for reliable service rate.
- A clear distinction between staging, drop-off, pass-through, and GPS drift.
- Per-zone calibration for airport vs hotel behavior.
- Accurate entry/exit timestamps with stable polygon boundaries.

## 14. Algorithm quality evaluation

The current model is a reasonable MVP because it combines live queue length, recent departures, and historical/rolling dwell. It is not yet robust enough for high-confidence real-world taxi operations in complex venues.

Strengths:

- Counts use fresh presence rather than stale counters.
- Service rate uses multiple windows.
- Dwell median is robust to outliers compared with average.
- Confidence/status is exposed.

Weaknesses:

- Departure events may not equal actual taxi load/dispatch events.
- Airport staging is not the same as hotel taxi stand behavior.
- GPS drift can inflate/fragment dwell time.
- Open visits can remain open if app dies or geofence exit is missed.
- One rolling 60-minute dwell window may be too short for sparse zones.
- `UNKNOWN` is counted, which can inflate queues if polygon certainty is low.
- No per-zone service model/calibration.

## 15. Airport vs hotel staging

Airport staging should likely use stricter queue-state logic:

- Staging lane polygon must be precise.
- Terminal dispatch/load events should be modeled separately from hotel pickup churn.
- Queue movement may happen in waves.
- Drivers may idle long periods while still legitimately staged.
- Terminal 1/T3 should have separate service-rate calibration.

Hotel zones likely need:

- Strong pass-through/drop-off filtering.
- Shorter dwell thresholds.
- More reliance on recent arrivals/departures and less on long dwell.

## 16. Recommended improvements

### P0/P1 algorithm diagnostics

- Show `cars_staged`, `active_presence_count`, departure counts by 15/30/60m, median dwell sample size, and wait status in admin.
- Add “why no wait estimate” reason to UI/admin.
- Add stale-data source label: RPC fresh vs cached fallback.

### P1/P2 model improvements

- Add per-zone minimum sample thresholds.
- Add per-zone dwell validity ranges.
- Split airport and hotel algorithms.
- Use queue position and observed progression when enough drivers participate.
- Add open-visit reconciliation to close stale visits.
- Avoid counting `UNKNOWN` by default once polygons are mature, or display it separately as uncertain.
- Add confidence labels that are driver-friendly: “Live count confirmed, wait estimate still learning.”

### P2/P3 product messaging

- Separate live count confidence from wait-time confidence.
- For one tester, show: “1 car live. Wait estimate needs more completed trips.”
- Avoid presenting “Not enough data” as if the live count is broken.

## 17. Terminal 1 relevance

The Terminal 1 bug is primarily a live-count/status/presence issue, not a wait-time algorithm issue. Even with no wait estimate, Terminal 1 should have shown `1 car` if presence was fresh and countable. The wait model can still show “Not enough data” or “No recent movement” during a one-driver test.
