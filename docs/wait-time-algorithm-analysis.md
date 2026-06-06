# LV Taxi — Wait-Time & Flow Algorithm Analysis

> Analysis-only. Full trace of `get_zone_live_stats()` math (`012_...:103-300`) and quality review.

---

## 1. Inputs & fields

- **`zone_visits`**: `dwell_seconds`, `classification` (→ median dwell).
- **`zone_departures`**: `departed_at` (→ flow / service rate).
- **`driver_presence`**: fresh STAGING/UNKNOWN rows (→ `cars_staged`).
- Outputs: `cars_staged`, `flow_rate_per_hour`, `smoothed_service_rate_per_hour`,
  `median_dwell_minutes`, `dwell_sample_size`, `estimated_wait_minutes`,
  `estimated_wait_min/max`, `wait_confidence`, `wait_status`, `last_updated`.

## 2. The formulas (exact)

1. **`cars_staged`** = `COUNT(DISTINCT driver_id)` over `driver_presence` where
   `last_ping_at > now()-90s AND current_zone_id NOT NULL AND classification IN (STAGING,UNKNOWN)`
   (`012_...:130-139`).
2. **Flow / smoothed service rate** — multi-window blend of `zone_departures`:
   - 15-min count × 4, 30-min count × 2, 60-min count × 1 (annualize to per-hour).
   - `smoothed_rate = 0.50·rate_15m + 0.30·rate_30m + 0.20·rate_60m` (`:160-173`).
   - Returned as `smoothed_service_rate_per_hour`. (`flow_rate_per_hour` returned from legacy
     `zone_stats`.)
3. **Median dwell** = `percentile_cont(0.5)` of `dwell_seconds`/60 over `zone_visits` with
   `exited_at NOT NULL`, `dwell_seconds BETWEEN 120 AND 7200`, `lower(classification)='staging'`,
   `exited_at > now()-60min` (`:177-191`). `sample_size = COUNT(*)`.
4. **Queue wait** = `cars_staged / (smoothed_rate/60)` only if `smoothed_rate >= 1.0`, else NULL
   (`:215-224`).
5. **Estimated wait (blended)**:
   - both present → `0.65·median_dwell + 0.35·queue_wait`
   - only one present → that one; neither → NULL (`:226-239`).
6. **Wait range** (`estimated_wait_min/max`) widens with magnitude: ±3 (<10), ±5 (<30), ±10 (<60),
   ±15 (≥60), min floored at 0 (`:251-265`).

## 3. Confidence & status

**`wait_confidence`** (`:267-284`):
- `INSUFFICIENT_DATA` if est_wait NULL.
- `HIGH` if sample ≥10 AND both metrics present AND smoothed_rate ≥2.0 AND
  |median−queue| ≤15.
- `MEDIUM` if sample 4–9, or only one metric present.
- `LOW` if sample 1–3, or smoothed_rate <1.0.

**`wait_status`** (`:286-292`):
- `INSUFFICIENT_DATA` if est_wait NULL and cars=0.
- `NO_RECENT_MOVEMENT` if est_wait NULL but cars>0 (cars present, no departures).
- `OK` otherwise.

## 4. Question-by-question

1. **cars_staged formula?** §2.1.
2. **flow_rate formula?** §2.2 (multi-window blend).
3. **smoothed service rate?** Same blend (§2.2).
4. **median dwell?** §2.3.
5. **estimated wait?** §2.5.
6. **sample size needed?** ≥4 for MEDIUM, ≥10 (+other gates) for HIGH.
7. **Why "Not enough data"?** est_wait NULL → `INSUFFICIENT_DATA`: no qualifying dwell samples in
   60 min AND no usable smoothed rate (no departures), so neither metric exists.
8. **Why "Data stale"?** UI-side: zone `last_updated` age >90 s in `ZoneListItem`. The RPC itself
   sets `last_updated=now()`, so "Data stale" means the client hasn't refreshed (poll/realtime gap)
   or is on the `zone_stats` fallback with an old timestamp.
9. **One driver testing alone?** A single tester produces ~0 departures and few completed staging
   visits → smoothed_rate ~0 (no queue wait) and tiny/zero dwell sample → `INSUFFICIENT_DATA` or
   `NO_RECENT_MOVEMENT`. Wait estimates are essentially unavailable with one driver.
10. **Data needed before meaningful?** Multiple completed STAGING visits per zone within 60 min
    (for median dwell) and several departures within 15–60 min (for service rate). Realistically
    several drivers cycling through.

## 5. Quality evaluation

- **Strengths:** presence-based count (not self-reported); multi-window smoothing dampens spikes;
  blends two independent signals (dwell vs queue/service); explicit confidence + range.
- **Gaps / risks:**
  - **Departure logging dependency** — if the client never writes `zone_departures`, service rate
    is always 0 → wait often unavailable. Confirm departures are actually written on exit.
  - **Drop-off / pass-through filtering** — dwell uses `classification='staging'` only, which is
    correct, but depends on `behavioralClassifier` / `finalize_visit_classification` accuracy; bad
    classification pollutes dwell.
  - **GPS drift** — a driver parked at the lane edge with jittery GPS can produce spurious
    zone exits/entries, inflating departures and shortening dwell.
  - **Airport vs hotel** — same algorithm for both; airport pits (T1/T3) have very different service
    dynamics (batch releases, holding lots) than hotel lines. No per-zone calibration.
  - **Median vs queue model** — median dwell is robust for steady lines; queue model (cars/rate)
    better for surge. The 0.65/0.35 blend is a fixed heuristic, not calibrated.
  - **Min sample** — HIGH requires ≥10 staging visits in 60 min; achievable at busy zones, rare at
    quiet ones, so most zones sit at MEDIUM/LOW.

## 6. Recommendations (not implemented)

- Verify and, if needed, instrument reliable `zone_departures` writes on every staging exit.
- Per-zone calibration table (service model weights, dwell bounds) — especially airport vs hotel.
- Airport-specific handling: account for holding-lot → pit batch releases.
- Configurable smoothing windows + min-sample thresholds per zone.
- Distinguish "stale (client not refreshing)" from "insufficient data" in UI copy.
- Driver-facing explanation of confidence ("based on N recent trips").
- Admin algorithm diagnostics page: show sample sizes, rates, and why a zone is INSUFFICIENT_DATA.

See `fix-roadmap.md` (P2/P3) and `system-risk-register.md` (wait-time confidence).
