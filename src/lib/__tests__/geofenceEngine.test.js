jest.mock('expo-location', () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 },
  getLastKnownPositionAsync: jest.fn(),
  hasStartedGeofencingAsync: jest.fn().mockResolvedValue(false),
  startGeofencingAsync: jest.fn().mockResolvedValue(undefined),
  stopGeofencingAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
}));

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
}));

jest.mock('../../store', () => ({
  store: {
    getState: jest.fn(() => ({
      zones: { allZones: [], stats: {}, activeSort: 'FLOW' },
      drivers: {},
      auth: { session: null },
    })),
    dispatch: jest.fn(),
    subscribe: jest.fn(),
  },
}));

jest.mock('../../store/driversSlice', () => ({
  zoneExited: jest.fn(() => ({ type: 'zoneExited' })),
}));

jest.mock('../../store/zonesSlice', () => ({
  setTop20Zones: jest.fn((payload) => ({ type: 'setTop20Zones', payload })),
}));

jest.mock('../supabase', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('../locationEngine', () => ({
  getDistanceMeters: jest.fn((lat1, lng1, lat2, lng2) =>
    Math.hypot(lat1 - lat2, lng1 - lng2)
  ),
}));

jest.mock('../trajectoryRecorder', () => ({
  stopRecording: jest.fn(() => ({ gpsPoints: [], features: {} })),
}));

jest.mock('../visitProcessor', () => ({
  processZoneExit: jest.fn(),
}));

jest.mock('../stagingService', () => ({
  enterStagingZone: jest.fn(),
}));

jest.mock('../zoneStatsEngine', () => ({
  clearDriverPresence: jest.fn(),
}));

jest.mock('../backgroundTracking/trackingDebug', () => ({
  recordTrackingDebug: jest.fn(),
}));

jest.mock('../polygonConfirmation', () => ({
  pointInZonePolygon: jest.fn(() => true),
}));

const { getTop20Zones } = require('../geofenceEngine');

describe('geofenceEngine monitored zones', () => {
  test('uses nearest physical zones regardless of UI sort', () => {
    const zones = [
      { id: 'far-high-flow', lat: 10, lng: 10, flow_rate_per_hour: 999 },
      { id: 'near', lat: 1, lng: 0 },
      { id: 'nearest', lat: 0.1, lng: 0 },
      { id: 'coming-soon', lat: 0, lng: 0, is_coming_soon: true },
    ];

    expect(getTop20Zones(zones, 'FLOW', 0, 0).map((z) => z.id)).toEqual([
      'nearest',
      'near',
      'far-high-flow',
    ]);
    expect(getTop20Zones(zones, 'WAIT', 0, 0).map((z) => z.id)).toEqual([
      'nearest',
      'near',
      'far-high-flow',
    ]);
  });

  test('caps monitored zones at 20', () => {
    const zones = Array.from({ length: 25 }, (_, i) => ({
      id: `zone-${i}`,
      lat: i,
      lng: 0,
    }));

    const monitored = getTop20Zones(zones, 'FLOW', 0, 0);

    expect(monitored).toHaveLength(20);
    expect(monitored.map((z) => z.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `zone-${i}`)
    );
  });
});
