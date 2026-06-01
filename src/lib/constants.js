export const STAGING_ZONES = [
  {
    id: '11111111-1111-1111-1111-000000000001',
    name: 'Harry Reid T1 (pit)',
    lat: 36.0830,
    lng: -115.1487,
    radius: 80,
  },
  {
    id: '11111111-1111-1111-1111-000000000002',
    name: 'Harry Reid T3 (pit)',
    lat: 36.0871,
    lng: -115.1453,
    radius: 80,
  },
  {
    id: '11111111-1111-1111-1111-000000000003',
    name: 'Bellagio',
    lat: 36.1126,
    lng: -115.1767,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000004',
    name: 'Caesars Palace',
    lat: 36.1162,
    lng: -115.1746,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000005',
    name: 'MGM Grand',
    lat: 36.1023,
    lng: -115.1697,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000006',
    name: 'Mandalay Bay',
    lat: 36.0926,
    lng: -115.1759,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000007',
    name: 'Venetian',
    lat: 36.1213,
    lng: -115.1695,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000008',
    name: 'Aria / Vdara',
    lat: 36.1075,
    lng: -115.1764,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000009',
    name: 'Cosmopolitan',
    lat: 36.1101,
    lng: -115.1745,
    radius: 40,
  },
  {
    id: '11111111-1111-1111-1111-00000000000A',
    name: 'Aria Main (East)',
    lat: 36.1071,
    lng: -115.1755,
    radius: 40,
  },
  {
    id: '11111111-1111-1111-1111-00000000000B',
    name: 'Palazzo',
    lat: 36.1224,
    lng: -115.1697,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-00000000000C',
    name: 'Paris',
    lat: 36.1126,
    lng: -115.1709,
    radius: 40,
  },
  {
    id: '11111111-1111-1111-1111-00000000000D',
    name: 'Luxor',
    lat: 36.0955,
    lng: -115.1761,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-00000000000E',
    name: 'Fontainebleau',
    lat: 36.1366,
    lng: -115.1620,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-00000000000F',
    name: 'Resorts World (Conrad)',
    lat: 36.1352,
    lng: -115.1672,
    radius: 50,
  },
];

// ── Location write policy ─────────────────────────────────────────────────────
// Three separate concepts, intentionally decoupled. Do NOT collapse them:
//
//   1. GPS acquisition       — how often the phone READS a fix.
//                              Can be every 1s in HIGH mode (locationEngine.js).
//                              This is a local, on-device read. It costs battery,
//                              not backend writes.
//   2. Presence heartbeat    — how often Supabase hears "driver is still here".
//                              Throttled to PRESENCE_HEARTBEAT_INTERVAL_SECONDS
//                              (~25s). Lightweight row only (no point arrays).
//                              Keeps driver_presence.last_ping_at fresh for the
//                              90s live-count TTL. NOT the same as raw trajectory.
//   3. Trajectory persistence — how raw GPS history is SAVED for classification.
//                              Buffered locally and written once per visit at
//                              zone exit (Option A), never one write per point.
//
// Why 25s and not 3–5s for presence: Supabase/Postgres is the current hot store
// and a 3–5s heartbeat per driver is a write firehose at scale. A 3–5s live
// heartbeat is ONLY appropriate for a future Redis/WebSocket/MQTT hot path — it
// is NOT appropriate for direct Supabase writes today. Do not lower this while
// Supabase is the live presence store.

// GPS can sample often locally, but backend writes must be controlled.
// These bound a *future* batch-flush path (Option B). The current default
// (Option A) keeps points in memory and persists once at visit exit, so the
// flush interval only matters if/when long visits force an intermediate flush.
export const TRAJECTORY_BATCH_FLUSH_INTERVAL_SECONDS = 5;
export const TRAJECTORY_BATCH_FLUSH_INTERVAL_MS =
  TRAJECTORY_BATCH_FLUSH_INTERVAL_SECONDS * 1000;

// Hard cap on points held in the in-memory trajectory buffer. When exceeded the
// recorder downsamples (drops oldest non-critical points) so the buffer can
// never grow unbounded during a long visit. Enough points remain to classify
// staging / drop-off / passing.
export const TRAJECTORY_MAX_BUFFER_POINTS = 300;

// ── Presence freshness ────────────────────────────────────────────────────────
// Single source of truth for the staleness window used everywhere:
// SQL views, RPC functions, UI freshness labels, and live counts.
export const PRESENCE_TTL_SECONDS = 90;
export const PRESENCE_TTL_MS = PRESENCE_TTL_SECONDS * 1000;

// How often the app refreshes driver_presence.last_ping_at while a driver is
// on duty. Must be comfortably below PRESENCE_TTL_SECONDS so a staged driver
// gets several heartbeats before the TTL would expire them from live counts.
// GPS may still sample every 1s in HIGH mode — only the Supabase write is
// throttled. Presence heartbeat is NOT raw trajectory persistence: it carries a
// single lightweight position, never the buffered point array. Keep this around
// 25s while Supabase is the hot store (see the 3–5s caveat above).
export const PRESENCE_HEARTBEAT_INTERVAL_SECONDS = 25;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = PRESENCE_HEARTBEAT_INTERVAL_SECONDS * 1000;

// ── Automatic background-tracking driver states ──────────────────────────────
// These are the source of truth for the automatic LV Taxi tracking architecture.
// The driver no longer taps "Start/End Shift": the app moves between these states
// purely from GPS position relative to the work-area and staging-zone polygons.
//
//   passive_far       — outside work area, far from boundary; ~20-min GPS, no heartbeat.
//   passive_near      — outside work area, near boundary; ~5-min GPS, no heartbeat.
//   active            — inside work-area polygon; active GPS + ~25s heartbeat (no zone).
//   staged            — inside a staging-zone polygon; heartbeat carries zone_id (counted).
//   exit_grace        — just left work area; 30-min grace, NOT counted, light GPS.
//   tracking_disabled — logout / revoked permission / inactive account / user-disabled.
//
// Legacy values (off_duty) are retained ONLY for backward compatibility with
// older driver rows and any UI that still references them.
export const DRIVER_STATUS = {
  PASSIVE_FAR: 'passive_far',
  PASSIVE_NEAR: 'passive_near',
  ACTIVE: 'active',
  STAGED: 'staged',
  EXIT_GRACE: 'exit_grace',
  TRACKING_DISABLED: 'tracking_disabled',
  // Legacy — do not use in new flows.
  OFF_DUTY: 'off_duty',
};

// ── Automatic-tracking timing ────────────────────────────────────────────────
// GPS sampling cadence per state. These bound how often the phone READS a fix in
// the background task — they are NOT backend-write intervals (presence is still
// throttled by PRESENCE_HEARTBEAT_INTERVAL_MS below).
export const PASSIVE_FAR_INTERVAL_MS = 20 * 60 * 1000;   // far outside work area
export const PASSIVE_NEAR_INTERVAL_MS = 5 * 60 * 1000;   // near the work-area boundary
export const ACTIVE_LOCATION_INTERVAL_MS = 5000;         // inside work area / staged
export const EXIT_GRACE_LOCATION_INTERVAL_MS = 60 * 1000; // light checks during grace

// How long a driver may stay outside the work-area polygon before we clear their
// presence and drop them back to passive tracking. Re-entering the polygon within
// this window returns them straight to ACTIVE.
export const WORK_AREA_EXIT_GRACE_MS = 30 * 60 * 1000;

// Distance (to the work-area polygon boundary) under which an outside driver is
// classified PASSIVE_NEAR instead of PASSIVE_FAR. The work-area polygon — never a
// native circle — is the source of truth; this only tunes the passive GPS cadence.
export const PASSIVE_NEAR_THRESHOLD_METERS = 3000;

// ── Driver-state predicates ──────────────────────────────────────────────────
// Centralised so UI, heartbeat, and background tasks all agree on what each
// automatic state means. Polygon position is the source of truth for the state;
// these only interpret it.

// Passive = outside the work area. Passive drivers are NEVER counted in zone math
// and NEVER write a driver_presence heartbeat.
export function isPassiveStatus(status) {
  return (
    status === DRIVER_STATUS.PASSIVE_FAR ||
    status === DRIVER_STATUS.PASSIVE_NEAR
  );
}

// Only ACTIVE / STAGED drivers refresh driver_presence. PASSIVE / EXIT_GRACE /
// TRACKING_DISABLED (and legacy OFF_DUTY) must not heartbeat.
export function isHeartbeatStatus(status) {
  return status === DRIVER_STATUS.ACTIVE || status === DRIVER_STATUS.STAGED;
}

// States where the active background location task should be running (driver is
// inside, or recently left, the work area).
export function isActiveParticipationStatus(status) {
  return (
    status === DRIVER_STATUS.ACTIVE ||
    status === DRIVER_STATUS.STAGED ||
    status === DRIVER_STATUS.EXIT_GRACE
  );
}

// Only STAGED drivers with a fresh heartbeat count toward a specific staging
// queue. ACTIVE (null zone), EXIT_GRACE and PASSIVE must never count.
export function countsInStagingMath(status) {
  return status === DRIVER_STATUS.STAGED;
}

export const SORT_OPTIONS = {
  NEAREST: 'nearest',
  FLOW: 'flow',
  WAIT: 'wait',
};
