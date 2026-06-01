// ── Location write-policy dev counters ────────────────────────────────────────
// Lightweight, development-only instrumentation that lets a developer confirm
// the Phase 2 invariant at a glance:
//
//   GPS acquisition (local reads)  ≫  presence writes  ≥  trajectory flushes
//
// GPS may fire ~1/sec in HIGH mode, but the backend should see only a presence
// heartbeat (~every 25s) and a single trajectory write per visit. These counters
// prove that ratio without spamming production.
//
// Nothing here writes to Supabase or persists anything — it only counts in
// memory and logs occasionally when __DEV__ is true.

let gpsFixes = 0;
let presenceWrites = 0;
let trajectoryFlushes = 0;
let lastLoggedAt = 0;

// How often (ms) to emit the ratio line in dev. Kept slow so it never floods
// the Metro console during a long drive.
const LOG_INTERVAL_MS = 60_000;

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

function maybeLog() {
  if (!isDev) return;
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) return;
  lastLoggedAt = now;
  console.log(
    `[locationWritePolicy] gpsFixes=${gpsFixes} presenceWrites=${presenceWrites} trajectoryFlushes=${trajectoryFlushes}`
  );
}

// Count one local GPS fix (does NOT imply a backend write).
export function recordGpsFix() {
  gpsFixes += 1;
  maybeLog();
}

// Count one presence heartbeat actually written to Supabase.
export function recordPresenceWrite() {
  presenceWrites += 1;
  maybeLog();
}

// Count one trajectory persisted to Supabase (per-visit save or batch flush).
export function recordTrajectoryFlush() {
  trajectoryFlushes += 1;
  maybeLog();
}

export function getWritePolicyCounters() {
  return { gpsFixes, presenceWrites, trajectoryFlushes };
}

// Mostly for tests / manual debugging.
export function resetWritePolicyCounters() {
  gpsFixes = 0;
  presenceWrites = 0;
  trajectoryFlushes = 0;
  lastLoggedAt = 0;
}
