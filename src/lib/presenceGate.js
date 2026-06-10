// ── Presence fix gate (accuracy + anti-spoof) ────────────────────────────────
// Pure decision for whether a GPS fix is trustworthy enough to write a presence
// heartbeat that could count a driver into a queue. Kept dependency-free so it is
// unit-testable and shared by every heartbeat caller.
//
// Rules:
//   • Android mock locations (loc.mocked === true) are rejected outright.
//   • A fix worse than the accuracy ceiling (metres) is rejected.
//   • Unknown accuracy (null/undefined, or a sentinel < 0 that some platforms
//     report) is NOT rejected here — it can't be assessed client-side and the
//     server eligibility view enforces the ceiling as the backstop.

import { MAX_PRESENCE_ACCURACY_METERS } from './constants';

export function isFixAcceptableForPresence(
  { accuracy, mocked } = {},
  maxAccuracy = MAX_PRESENCE_ACCURACY_METERS
) {
  if (mocked === true) {
    return { ok: false, reason: 'mocked_location' };
  }
  if (
    accuracy != null &&
    Number.isFinite(accuracy) &&
    accuracy >= 0 &&
    accuracy > maxAccuracy
  ) {
    return { ok: false, reason: 'accuracy_too_low' };
  }
  return { ok: true, reason: 'ok' };
}
