function friendlyGeoError(err) {
  if (!err) return new Error('Unknown GPS error');
  // PositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
  if (err.code === 1) {
    return new Error(
      'Location blocked. Click the 🔒 in the address bar → Site settings → Location → Allow, then reload.'
    );
  }
  if (err.code === 2) {
    return new Error(
      'GPS unavailable. On desktop, enable Windows Location Services (Settings → Privacy → Location) and try again.'
    );
  }
  if (err.code === 3) return new Error('GPS timeout. Try again outside.');
  return new Error(err.message || 'GPS error');
}

// Minimal one-shot position fetch.
export function getOnePosition({ timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation unavailable in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          ts: pos.timestamp,
        }),
      (err) => reject(friendlyGeoError(err)),
      { enableHighAccuracy: true, timeout, maximumAge: 2_000 }
    );
  });
}

// React-free helper because Builder owns its own state machine.
// Returns a watcher object: .stop() to cancel.
export function startWatch({ onPoint, onError }) {
  if (!navigator.geolocation) {
    onError?.(new Error('Geolocation unavailable in this browser'));
    return { stop: () => {} };
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onPoint?.({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: pos.timestamp,
      });
    },
    (err) => onError?.(friendlyGeoError(err)),
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 2_000 }
  );
  return { stop: () => navigator.geolocation.clearWatch(id) };
}
