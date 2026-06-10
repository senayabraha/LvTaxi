// Tests for the GPS-cadence logic in tierManager (LIFE-1 consolidation).
// Verifies that statusToTier maps driver statuses correctly and that applyTier
// drives the foreground location engine without any DB writes.

jest.mock('../locationEngine', () => ({
  GPS_MODE: { HIGH: 'HIGH', LOW: 'LOW', PASSIVE: 'PASSIVE' },
  startLocationTracking: jest.fn().mockResolvedValue(undefined),
  stopLocationTracking:  jest.fn(),
  setGPSMode:            jest.fn().mockResolvedValue(undefined),
  onSmoothedLocation:    jest.fn(() => () => {}),
}));

jest.mock('../../store', () => {
  let state = { drivers: { status: 'tracking_disabled', gpsTier: 3 } };
  const listeners = new Set();
  return {
    store: {
      getState: () => state,
      dispatch: jest.fn(),
      subscribe: jest.fn((fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }),
      _setState: (s) => {
        state = s;
        listeners.forEach((fn) => fn());
      },
    },
  };
});

jest.mock('../../store/driversSlice', () => ({
  setGpsTier: jest.fn((t) => ({ type: 'drivers/setGpsTier', payload: t })),
}));

const { statusToTier, TIER, TIER_CONFIG, startTierManager, stopTierManager } =
  require('../tierManager');
const { GPS_MODE, setGPSMode, startLocationTracking } = require('../locationEngine');
const { store } = require('../../store');
const { setGpsTier } = require('../../store/driversSlice');

describe('statusToTier', () => {
  test('STAGED → TIER.ONE', () => {
    expect(statusToTier('staged')).toBe(TIER.ONE);
  });

  test('ACTIVE → TIER.TWO', () => {
    expect(statusToTier('active')).toBe(TIER.TWO);
  });

  test('EXIT_GRACE → TIER.TWO', () => {
    expect(statusToTier('exit_grace')).toBe(TIER.TWO);
  });

  test('PASSIVE_NEAR → TIER.TWO', () => {
    expect(statusToTier('passive_near')).toBe(TIER.TWO);
  });

  test('PASSIVE_FAR → TIER.THREE', () => {
    expect(statusToTier('passive_far')).toBe(TIER.THREE);
  });

  test('TRACKING_DISABLED → TIER.THREE', () => {
    expect(statusToTier('tracking_disabled')).toBe(TIER.THREE);
  });

  test('unknown status → TIER.THREE', () => {
    expect(statusToTier('off_duty')).toBe(TIER.THREE);
    expect(statusToTier(null)).toBe(TIER.THREE);
    expect(statusToTier(undefined)).toBe(TIER.THREE);
  });
});

describe('TIER_CONFIG', () => {
  test('Tier 1 uses HIGH mode (staged: fast GPS)', () => {
    expect(TIER_CONFIG[TIER.ONE].mode).toBe(GPS_MODE.HIGH);
  });

  test('Tier 2 uses LOW mode (active / exit grace: moderate GPS)', () => {
    expect(TIER_CONFIG[TIER.TWO].mode).toBe(GPS_MODE.LOW);
  });

  test('Tier 3 uses PASSIVE mode (far outside work area: minimal GPS)', () => {
    expect(TIER_CONFIG[TIER.THREE].mode).toBe(GPS_MODE.PASSIVE);
  });
});

describe('startTierManager', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset module state between tests by stopping and re-requiring.
    await stopTierManager();
  });

  test('starts foreground location tracking at passive mode on boot', async () => {
    store._setState({ drivers: { status: 'tracking_disabled', gpsTier: 3 } });
    await startTierManager();
    expect(startLocationTracking).toHaveBeenCalledWith(GPS_MODE.PASSIVE);
    await stopTierManager();
  });

  test('upgrades GPS mode when status changes to STAGED', async () => {
    store._setState({ drivers: { status: 'tracking_disabled', gpsTier: 3 } });
    await startTierManager();
    jest.clearAllMocks();

    // Simulate background task setting status = staged
    store._setState({ drivers: { status: 'staged', gpsTier: 3 } });

    // Give the async applyTier a tick to run.
    await new Promise((r) => setImmediate(r));
    expect(setGPSMode).toHaveBeenCalledWith(GPS_MODE.HIGH);
    await stopTierManager();
  });

  test('downgrades GPS mode when STAGED → PASSIVE_FAR', async () => {
    store._setState({ drivers: { status: 'staged', gpsTier: 1 } });
    await startTierManager();
    jest.clearAllMocks();

    store._setState({ drivers: { status: 'passive_far', gpsTier: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(setGPSMode).toHaveBeenCalledWith(GPS_MODE.PASSIVE);
    await stopTierManager();
  });

  test('does not call setGPSMode when status changes but tier stays the same', async () => {
    store._setState({ drivers: { status: 'active', gpsTier: 2 } });
    await startTierManager();
    jest.clearAllMocks();

    // active → exit_grace: both map to TIER.TWO, no mode change expected
    store._setState({ drivers: { status: 'exit_grace', gpsTier: 2 } });
    await new Promise((r) => setImmediate(r));
    expect(setGPSMode).not.toHaveBeenCalled();
    await stopTierManager();
  });

  test('is idempotent — calling startTierManager twice does not double-subscribe', async () => {
    store._setState({ drivers: { status: 'tracking_disabled', gpsTier: 3 } });
    await startTierManager();
    await startTierManager(); // second call should no-op
    expect(startLocationTracking).toHaveBeenCalledTimes(1);
    await stopTierManager();
  });

  test('stopTierManager unsubscribes from the store', async () => {
    store._setState({ drivers: { status: 'tracking_disabled', gpsTier: 3 } });
    await startTierManager();
    await stopTierManager();
    jest.clearAllMocks();

    // Change status after stop — should NOT trigger setGPSMode
    store._setState({ drivers: { status: 'staged', gpsTier: 3 } });
    await new Promise((r) => setImmediate(r));
    expect(setGPSMode).not.toHaveBeenCalled();
  });
});
