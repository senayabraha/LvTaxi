jest.mock('../supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../offlineCache', () => ({
  savePendingTrajectory: jest.fn(),
  loadPendingTrajectories: jest.fn().mockResolvedValue([]),
  clearPendingTrajectory: jest.fn(),
  savePendingVisitSideEffect: jest.fn(),
  loadPendingVisitSideEffects: jest.fn().mockResolvedValue([]),
  clearPendingVisitSideEffect: jest.fn(),
  bumpVisitSideEffectAttempt: jest.fn(),
}));

jest.mock('../zoneStatsEngine', () => ({
  clearDriverPresence: jest.fn(),
  recordLoadEvent: jest.fn(),
}));

jest.mock('../notificationService', () => ({
  sendStagingConfirmation: jest.fn(),
}));

jest.mock('../trajectoryRecorder', () => ({
  extractFeatures: jest.fn(() => ({})),
}));

jest.mock('../locationWritePolicy', () => ({
  recordTrajectoryFlush: jest.fn(),
}));

const { supabase } = require('../supabase');
const {
  savePendingVisitSideEffect,
  loadPendingVisitSideEffects,
  clearPendingVisitSideEffect,
} = require('../offlineCache');
const {
  saveTrainingData,
  retryPendingVisitSideEffects,
} = require('../visitProcessor');

function updateChain(error = null) {
  return {
    update: jest.fn(() => ({
      eq: jest.fn().mockResolvedValue({ error }),
    })),
  };
}

describe('visitProcessor training confirmation offline queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadPendingVisitSideEffects.mockResolvedValue([]);
  });

  test('queues SAVE_TRAINING_DATA when confirmation write fails', async () => {
    supabase.from.mockReturnValue(updateChain({ message: 'offline' }));

    await saveTrainingData('visit-1', 'staging', { source: 'tap' });

    expect(savePendingVisitSideEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'SAVE_TRAINING_DATA:visit-1:staging',
        type: 'SAVE_TRAINING_DATA',
        visit_id: 'visit-1',
        payload: expect.objectContaining({
          confirmedLabel: 'staging',
          extra: { source: 'tap' },
        }),
      })
    );
  });

  test('replays queued SAVE_TRAINING_DATA and clears the record', async () => {
    loadPendingVisitSideEffects.mockResolvedValue([
      {
        id: 'SAVE_TRAINING_DATA:visit-1:drop_off',
        type: 'SAVE_TRAINING_DATA',
        visit_id: 'visit-1',
        payload: { confirmedLabel: 'drop_off' },
      },
    ]);
    supabase.from
      .mockReturnValueOnce(updateChain(null))
      .mockReturnValueOnce(updateChain(null));

    const result = await retryPendingVisitSideEffects();

    expect(result).toEqual({ replayed: 1, failed: 0 });
    expect(supabase.from).toHaveBeenNthCalledWith(1, 'zone_visits');
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'trajectories');
    expect(clearPendingVisitSideEffect).toHaveBeenCalledWith(
      'SAVE_TRAINING_DATA:visit-1:drop_off'
    );
  });
});
