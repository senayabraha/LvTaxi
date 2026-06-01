import { PRESENCE_TTL_MS } from './constants';

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
