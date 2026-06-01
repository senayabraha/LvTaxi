// ── Offline queue diagnostics (development only) ──────────────────────────────
// Lets a developer confirm the offline retry queues are draining without
// exposing anything to drivers or spamming production. All output is gated on
// __DEV__.
import {
  loadPendingTrajectories,
  loadPendingVisitSideEffects,
} from './offlineCache';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

// result: { saved, replayed, failed } from a retry pass.
export async function logOfflineRetry(reason, result = {}) {
  if (!isDev) return;
  try {
    const [pt, pse] = await Promise.all([
      loadPendingTrajectories(),
      loadPendingVisitSideEffects(),
    ]);
    const saved = result.saved ?? 0;
    const replayed = result.replayed ?? 0;
    const failed = result.failed ?? 0;
    console.log(
      `[offlineRetry] reason=${reason} pendingTrajectories=${pt.length} ` +
        `pendingSideEffects=${pse.length} saved=${saved} replayed=${replayed} failed=${failed}`
    );
  } catch (err) {
    // Diagnostics must never break a retry.
  }
}

// Snapshot of current queue depths (dev helper).
export async function getOfflineQueueDepths() {
  const [pt, pse] = await Promise.all([
    loadPendingTrajectories(),
    loadPendingVisitSideEffects(),
  ]);
  return { pendingTrajectories: pt.length, pendingSideEffects: pse.length };
}
