// ── Offline retry manager ─────────────────────────────────────────────────────
// Drains the offline queues (pending trajectories + pending post-visit side
// effects) when connectivity returns — not only on app launch. It listens to
// NetInfo and, on an offline→online transition, schedules a single debounced
// retry pass. A retryInFlight guard prevents concurrent/overlapping drains so
// repeated NetInfo events can never spam Supabase.
//
// This introduces NO new high-frequency writes: it only replays writes that
// already failed once, and it runs at most once per reconnect (debounced).
import NetInfo from '@react-native-community/netinfo';
import {
  retryPendingTrajectories,
  retryPendingVisitSideEffects,
} from './visitProcessor';
import { logOfflineRetry } from './offlineQueueDiagnostics';

let unsubscribe = null;
let retryInFlight = false;
let lastOnline = null;
let debounceTimer = null;

// Coalesce bursty NetInfo events (e.g. flapping Wi-Fi) into one retry pass.
const RECONNECT_DEBOUNCE_MS = 2000;

async function runRetry(reason) {
  if (retryInFlight) return;
  retryInFlight = true;
  try {
    // Trajectories first (the GPS history), then the compact side effects.
    const traj = await retryPendingTrajectories();
    const side = await retryPendingVisitSideEffects();
    await logOfflineRetry(reason, {
      saved: traj?.saved ?? 0,
      replayed: side?.replayed ?? 0,
      failed: (traj?.failed ?? 0) + (side?.failed ?? 0),
    });
  } catch (err) {
    console.warn('[offlineRetryManager] retry pass failed', err);
  } finally {
    retryInFlight = false;
  }
}

function scheduleRetry(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runRetry(reason);
  }, RECONNECT_DEBOUNCE_MS);
}

// Safe to call multiple times — a second call while already subscribed is a
// no-op.
export function startOfflineRetryManager() {
  if (unsubscribe) return;
  unsubscribe = NetInfo.addEventListener((state) => {
    const online = !!state.isConnected && state.isInternetReachable !== false;
    // Only act on a genuine offline→online transition.
    if (online && lastOnline === false) scheduleRetry('reconnect');
    lastOnline = online;
  });
  // On startup, if we're already online, drain anything left from a prior run
  // (this preserves the "retry on launch" behaviour).
  NetInfo.fetch()
    .then((state) => {
      const online = !!state.isConnected && state.isInternetReachable !== false;
      lastOnline = online;
      if (online) scheduleRetry('startup-online');
    })
    .catch(() => {});
}

export function stopOfflineRetryManager() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  retryInFlight = false;
  lastOnline = null;
}

// Manual trigger (e.g. from a pull-to-refresh or a test) — still guarded.
export async function runPendingRetries(reason = 'manual') {
  return runRetry(reason);
}
