// Tests for enterStagingZone() — the single staging entry point (Issue 7 / CNT-1/CNT-2).
// Verifies that all 4 entry paths (geofence, active task, passive task, manual)
// produce the same invariants: transition → reset throttle → start recording → heartbeat.

jest.mock('../driverStatusTransitions', () => ({
  transitionToStaged: jest.fn(),
}));
jest.mock('../presenceHeartbeat', () => ({
  resetPresenceHeartbeat: jest.fn(),
  maybeSendPresenceHeartbeat: jest.fn(),
}));
jest.mock('../trajectoryRecorder', () => ({
  startRecording: jest.fn(),
}));

const { enterStagingZone } = require('../stagingService');
const { transitionToStaged } = require('../driverStatusTransitions');
const {
  resetPresenceHeartbeat,
  maybeSendPresenceHeartbeat,
} = require('../presenceHeartbeat');
const { startRecording } = require('../trajectoryRecorder');

const DRIVER_ID = 'driver-abc';
const ZONE_ID   = 'zone-xyz';
const VISIT_ID  = 'visit-123';

describe('enterStagingZone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transitionToStaged.mockResolvedValue({ ok: true, visitId: VISIT_ID });
    maybeSendPresenceHeartbeat.mockResolvedValue(true);
  });

  // ── Invariants common to every path ─────────────────────────────────────────

  test('always calls transitionToStaged with driverId and zoneId', async () => {
    await enterStagingZone({ driverId: DRIVER_ID, zoneId: ZONE_ID });
    expect(transitionToStaged).toHaveBeenCalledWith(
      DRIVER_ID,
      ZONE_ID,
      expect.any(Object)
    );
  });

  test('always resets the heartbeat throttle so a fresh write fires immediately', async () => {
    await enterStagingZone({ driverId: DRIVER_ID, zoneId: ZONE_ID });
    expect(resetPresenceHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('always starts trajectory recording with the visitId from the transition', async () => {
    await enterStagingZone({ driverId: DRIVER_ID, zoneId: ZONE_ID });
    expect(startRecording).toHaveBeenCalledWith(VISIT_ID, null);
  });

  test('passes zone center to startRecording when zone object is provided', async () => {
    const zone = { id: ZONE_ID, lat: 36.1, lng: -115.1, name: 'Test Zone' };
    await enterStagingZone({ driverId: DRIVER_ID, zoneId: ZONE_ID, zone });
    expect(startRecording).toHaveBeenCalledWith(VISIT_ID, { lat: 36.1, lng: -115.1 });
  });

  test('returns visitId and ok from transitionToStaged', async () => {
    const result = await enterStagingZone({
      driverId: DRIVER_ID,
      zoneId: ZONE_ID,
      lat: 36.1,
      lng: -115.1,
    });
    expect(result.ok).toBe(true);
    expect(result.visitId).toBe(VISIT_ID);
  });

  // ── Forced heartbeat ─────────────────────────────────────────────────────────

  test('sends a forced heartbeat with visitId when coordinates are present', async () => {
    const result = await enterStagingZone({
      driverId: DRIVER_ID,
      zoneId: ZONE_ID,
      lat: 36.1,
      lng: -115.1,
      accuracy: 10,
      speed: 0.5,
    });
    expect(maybeSendPresenceHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        driverId:       DRIVER_ID,
        zoneId:         ZONE_ID,
        classification: 'STAGING',
        force:          true,
        visitId:        VISIT_ID,
        lat:            36.1,
        lng:            -115.1,
      })
    );
    expect(result.heartbeatSent).toBe(true);
  });

  test('skips heartbeat when no coordinates are provided (active task path without fix)', async () => {
    await enterStagingZone({ driverId: DRIVER_ID, zoneId: ZONE_ID });
    expect(maybeSendPresenceHeartbeat).not.toHaveBeenCalled();
  });

  test('reports heartbeatSent=false when maybeSendPresenceHeartbeat returns false', async () => {
    maybeSendPresenceHeartbeat.mockResolvedValue(false);
    const result = await enterStagingZone({
      driverId: DRIVER_ID,
      zoneId: ZONE_ID,
      lat: 36.1,
      lng: -115.1,
    });
    expect(result.heartbeatSent).toBe(false);
  });

  // ── Active task path ─────────────────────────────────────────────────────────

  test('passes skipTaskRestart=true for the active-task path (prevents crash on Android)', async () => {
    await enterStagingZone({
      driverId: DRIVER_ID,
      zoneId: ZONE_ID,
      skipTaskRestart: true,
    });
    expect(transitionToStaged).toHaveBeenCalledWith(
      DRIVER_ID,
      ZONE_ID,
      expect.objectContaining({ skipTaskRestart: true })
    );
  });

  // ── Passive task path ────────────────────────────────────────────────────────

  test('passes source through to transitionToStaged (e.g. passiveLocationTask)', async () => {
    await enterStagingZone({
      driverId: DRIVER_ID,
      zoneId: ZONE_ID,
      source: 'passiveLocationTask',
    });
    expect(transitionToStaged).toHaveBeenCalledWith(
      DRIVER_ID,
      ZONE_ID,
      expect.objectContaining({ source: 'passiveLocationTask' })
    );
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  test('still resets throttle and starts recording even when transition fails', async () => {
    transitionToStaged.mockResolvedValue({ ok: false, error: 'db_error' });
    const result = await enterStagingZone({
      driverId: DRIVER_ID,
      zoneId: ZONE_ID,
    });
    expect(result.ok).toBe(false);
    // Throttle reset and recording must still happen — partial state is
    // better than leaving a stale throttle window blocking the next write.
    expect(resetPresenceHeartbeat).toHaveBeenCalled();
    expect(startRecording).toHaveBeenCalled();
  });

  test('null visitId is handled gracefully (startRecording receives null)', async () => {
    transitionToStaged.mockResolvedValue({ ok: true, visitId: null });
    await enterStagingZone({ driverId: DRIVER_ID, zoneId: ZONE_ID });
    expect(startRecording).toHaveBeenCalledWith(null, null);
  });
});
