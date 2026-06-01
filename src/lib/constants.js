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

export const DRIVER_STATUS = {
  ACTIVE: 'active',
  STAGED: 'staged',
  OFF_DUTY: 'off_duty',
};

export const SORT_OPTIONS = {
  NEAREST: 'nearest',
  FLOW: 'flow',
  WAIT: 'wait',
};
