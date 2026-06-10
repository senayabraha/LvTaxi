// Tests for visit-lifecycle fixes (Issue 13: LIFE-7 and LIFE-9).
//
// LIFE-7: startExitGrace must close any open zone_visits row and run classification
//   before clearing presence (not leave the row dangling with no exit timestamp).
//
// LIFE-9: closeOrphanedVisits must preserve in-progress visits when the driver
//   is still physically inside the zone on relaunch.

// ── Shared mocks ──────────────────────────────────────────────────────────────

const mockSupabaseFrom = jest.fn();
const mockSelect = jest.fn();
const mockEq    = jest.fn();
const mockIs    = jest.fn();
const mockMaybeSingle = jest.fn();
const mockUpdate = jest.fn();

// Each chain returns itself so we can do .from().select().eq().is().maybeSingle()
function chainable(result) {
  const obj = {
    select: jest.fn(() => obj),
    eq:     jest.fn(() => obj),
    is:     jest.fn(() => obj),
    update: jest.fn(() => obj),
    maybeSingle: jest.fn().mockResolvedValue(result),
  };
  // update().eq() needs to resolve too
  obj.update.mockImplementation(() => ({
    eq: jest.fn().mockResolvedValue({ error: null }),
  }));
  return obj;
}

jest.mock('../supabase', () => ({
  supabase: {
    from: jest.fn(),
  },
}));

jest.mock('../zoneStatsEngine', () => ({
  clearDriverPresence: jest.fn().mockResolvedValue({ error: null }),
}));

jest.mock('../notificationService', () => ({
  sendStagingConfirmation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../trajectoryRecorder', () => ({
  stopRecording: jest.fn().mockReturnValue({ gpsPoints: [], features: {} }),
  startRecording: jest.fn(),
}));

jest.mock('../visitProcessor', () => ({
  processZoneExit: jest.fn().mockResolvedValue({ classification: 'passing', warnings: [] }),
}));

jest.mock('../../store', () => ({
  store: {
    getState: jest.fn(() => ({
      drivers: { status: 'staged', currentZoneId: 'zone-1' },
    })),
    dispatch: jest.fn(),
  },
}));

jest.mock('../../store/driversSlice', () => ({
  setStatus:                  jest.fn((s) => ({ type: 'setStatus', payload: s })),
  setWorkAreaExitStartedAt:   jest.fn((t) => ({ type: 'setWorkAreaExitStartedAt', payload: t })),
  clearWorkAreaExitStartedAt: jest.fn(()  => ({ type: 'clearWorkAreaExitStartedAt' })),
  setCurrentZone:             jest.fn((z) => ({ type: 'setCurrentZone', payload: z })),
}));

jest.mock('../driverStatusTransitions', () => ({
  transitionDriverState: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../workAreaGeometry', () => ({
  classifyPassiveDistance:   jest.fn(() => 'passive_far'),
  detectStagingZoneFromPoint: jest.fn(),
  refreshWorkAreaCache:       jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../presenceFreshness', () => ({
  isExitGraceExpired: jest.fn(() => false),
}));

jest.mock('../backgroundTracking/trackingDebug', () => ({
  recordTrackingDebug: jest.fn(),
}));

jest.mock('../backgroundTracking/backgroundTrackingService', () => ({
  startPassiveTracking:      jest.fn().mockResolvedValue(true),
  startExitGraceTracking:    jest.fn().mockResolvedValue(true),
  stopActiveTracking:        jest.fn().mockResolvedValue(true),
}));

jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: jest.fn(),
}));

// ── LIFE-7 tests ─────────────────────────────────────────────────────────────

describe('LIFE-7 — startExitGrace closes open visit before clearing presence', () => {
  const { supabase } = require('../supabase');
  const { clearDriverPresence } = require('../zoneStatsEngine');
  const { processZoneExit } = require('../visitProcessor');
  const { stopRecording } = require('../trajectoryRecorder');

  const DRIVER_ID = 'driver-abc';
  const VISIT_ID  = 'visit-xyz';
  const ZONE_ID   = 'zone-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('closes the open visit row with exited_at + dwell_seconds', async () => {
    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const updateFn = jest.fn(() => ({ eq: updateEq }));

    // First call: query open visit
    supabase.from.mockImplementationOnce(() => ({
      select:      jest.fn().mockReturnThis(),
      eq:          jest.fn().mockReturnThis(),
      is:          jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: VISIT_ID, zone_id: ZONE_ID, entered_at: new Date(Date.now() - 300_000).toISOString() },
        error: null,
      }),
    }));
    // Second call: update the visit
    supabase.from.mockImplementationOnce(() => ({
      update: updateFn,
    }));

    const { startExitGrace } = require('../backgroundTracking/exitGraceManager');
    await startExitGrace(DRIVER_ID, null);

    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ exited_at: expect.any(String), dwell_seconds: expect.any(Number) })
    );
    expect(updateEq).toHaveBeenCalledWith('id', VISIT_ID);
  });

  test('calls processZoneExit for classification after closing the visit', async () => {
    supabase.from.mockImplementationOnce(() => ({
      select:      jest.fn().mockReturnThis(),
      eq:          jest.fn().mockReturnThis(),
      is:          jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: VISIT_ID, zone_id: ZONE_ID, entered_at: new Date(Date.now() - 60_000).toISOString() },
        error: null,
      }),
    }));
    supabase.from.mockImplementationOnce(() => ({
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
    }));

    const { startExitGrace } = require('../backgroundTracking/exitGraceManager');
    await startExitGrace(DRIVER_ID, null);

    expect(processZoneExit).toHaveBeenCalledWith(
      VISIT_ID,
      DRIVER_ID,
      ZONE_ID,
      expect.any(Array)
    );
  });

  test('still clears presence when there is no open visit', async () => {
    supabase.from.mockImplementationOnce(() => ({
      select:      jest.fn().mockReturnThis(),
      eq:          jest.fn().mockReturnThis(),
      is:          jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    }));

    const { startExitGrace } = require('../backgroundTracking/exitGraceManager');
    await startExitGrace(DRIVER_ID, null);

    expect(processZoneExit).not.toHaveBeenCalled();
    expect(clearDriverPresence).toHaveBeenCalledWith(DRIVER_ID);
  });
});

// ── LIFE-9 tests ─────────────────────────────────────────────────────────────

describe('LIFE-9 — closeOrphanedVisits preserves in-progress visits', () => {
  const { supabase } = require('../supabase');
  const { clearDriverPresence } = require('../zoneStatsEngine');
  const Location = require('expo-location');
  const { detectStagingZoneFromPoint } = require('../workAreaGeometry');

  const DRIVER_ID = 'driver-abc';
  const ZONE_ID   = 'zone-1';
  const OTHER_ZONE = 'zone-2';

  const openVisit = {
    id: 'visit-1',
    zone_id: ZONE_ID,
    entered_at: new Date(Date.now() - 180_000).toISOString(), // 3 min ago
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('preserves visit and does NOT clear presence when driver is still in zone', async () => {
    // Return open visit from DB
    supabase.from.mockImplementation(() => ({
      select:      jest.fn().mockReturnThis(),
      eq:          jest.fn().mockReturnThis(),
      is:          jest.fn().mockReturnThis(),
      update:      jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
      maybeSingle: jest.fn().mockResolvedValue(undefined),
      then:        undefined,
      // Simulate the array result (no maybeSingle)
      _rows:       [openVisit],
    }));

    // The zone_visits select returns an array, not maybeSingle
    let firstCall = true;
    supabase.from.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return {
          select: jest.fn().mockReturnThis(),
          eq:     jest.fn().mockReturnThis(),
          is:     jest.fn().mockResolvedValue({ data: [openVisit], error: null }),
        };
      }
      return {
        select: jest.fn().mockReturnThis(),
        eq:     jest.fn().mockReturnThis(),
        is:     jest.fn().mockReturnThis(),
        update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    Location.getLastKnownPositionAsync.mockResolvedValue({
      coords: { latitude: 36.1, longitude: -115.1 },
    });
    detectStagingZoneFromPoint.mockReturnValue({ id: ZONE_ID, name: 'Test Zone' });

    const { closeOrphanedVisits } = require('../visitReconciler');
    await closeOrphanedVisits(DRIVER_ID);

    // Driver is still in zone — presence must NOT be cleared
    expect(clearDriverPresence).not.toHaveBeenCalled();
  });

  test('abandons visit and clears presence when driver is no longer in zone', async () => {
    supabase.from.mockImplementation(() => {
      let call = 0;
      return {
        select: jest.fn().mockReturnThis(),
        eq:     jest.fn().mockReturnThis(),
        is:     jest.fn().mockImplementation(() => {
          call++;
          if (call === 1) return Promise.resolve({ data: [openVisit], error: null });
          return { maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) };
        }),
        update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    Location.getLastKnownPositionAsync.mockResolvedValue({
      coords: { latitude: 36.2, longitude: -115.2 },
    });
    // Driver is in a different zone (or null)
    detectStagingZoneFromPoint.mockReturnValue({ id: OTHER_ZONE });

    const { closeOrphanedVisits } = require('../visitReconciler');
    await closeOrphanedVisits(DRIVER_ID);

    expect(clearDriverPresence).toHaveBeenCalledWith(DRIVER_ID);
  });

  test('abandons visit when position is unavailable (safe fallback)', async () => {
    supabase.from.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq:     jest.fn().mockReturnThis(),
      is:     jest.fn().mockResolvedValue({ data: [openVisit], error: null }),
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    }));

    Location.getLastKnownPositionAsync.mockResolvedValue(null);

    const { closeOrphanedVisits } = require('../visitReconciler');
    await closeOrphanedVisits(DRIVER_ID);

    // No position → cannot confirm driver is in zone → abandon
    expect(clearDriverPresence).toHaveBeenCalledWith(DRIVER_ID);
  });
});
