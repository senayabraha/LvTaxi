import { PRESENCE_TTL_MS, WORK_AREA_EXIT_GRACE_MS } from './constants';

export function isPresenceFresh(lastPingAt, now = Date.now()) {
  if (!lastPingAt) return false;
  const lastPingMs = new Date(lastPingAt).getTime();
  if (Number.isNaN(lastPingMs)) return false;
  return now - lastPingMs <= PRESENCE_TTL_MS;
}

// Returns elapsed seconds since lastPingAt, or null if unparseable.
export function secondsSincePing(lastPingAt, now = Date.now()) {
  if (!lastPingAt) return null;
  const ms = new Date(lastPingAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor((now - ms) / 1000);
}

// Pure 30-minute exit-grace boundary (Issue 15). Timestamp-based so it survives
// background-task suspension/relaunch. Returns true once the driver has been
// outside the work area for at least WORK_AREA_EXIT_GRACE_MS.
export function isExitGraceExpired(startedAtMs, now = Date.now()) {
  if (startedAtMs == null) return false;
  return now - startedAtMs >= WORK_AREA_EXIT_GRACE_MS;
}
