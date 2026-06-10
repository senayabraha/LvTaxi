import { createSlice } from '@reduxjs/toolkit';
import { DRIVER_STATUS, SORT_OPTIONS } from '../lib/constants';

// All valid automatic-tracking statuses (plus legacy OFF_DUTY for compatibility).
const VALID_STATUSES = new Set(Object.values(DRIVER_STATUS));

const initialState = {
  profile: null,
  // The automatic tracking system owns this. We start TRACKING_DISABLED and let
  // app-launch reconciliation (permission + tracking_enabled + GPS position)
  // move us into PASSIVE_FAR/PASSIVE_NEAR/ACTIVE/etc. — the driver never taps
  // "Start Shift".
  status: DRIVER_STATUS.TRACKING_DISABLED,
  // Master switch: logout / revoked permission / inactive account / user toggle.
  trackingEnabled: true,
  currentLat: null,
  currentLng: null,
  rawAccuracy: null,
  mocked: false,
  speed: null,
  heading: null,
  acceleration: null,
  currentZoneId: null,
  isInsideZone: false,
  zoneEntryTime: null,
  // Work-area bookkeeping for the automatic state machine.
  workAreaEntryTime: null,
  workAreaExitStartedAt: null, // when EXIT_GRACE began (timestamp-based grace)
  workAreaExitTime: null,
  activeSort: SORT_OPTIONS.NEAREST,
  gpsTier: 3,
};

const driversSlice = createSlice({
  name: 'drivers',
  initialState,
  reducers: {
    setProfile(state, action) {
      state.profile = action.payload;
      if (action.payload?.status && VALID_STATUSES.has(action.payload.status)) {
        state.status = action.payload.status;
      }
      // tracking_enabled defaults to true unless the row explicitly disables it.
      if (action.payload && 'tracking_enabled' in action.payload) {
        state.trackingEnabled = action.payload.tracking_enabled !== false;
      }
    },
    clearProfile(state) {
      state.profile = null;
      // Logout → tracking fully disabled until next session bootstrap.
      state.status = DRIVER_STATUS.TRACKING_DISABLED;
      state.trackingEnabled = true;
      state.currentZoneId = null;
      state.isInsideZone = false;
      state.zoneEntryTime = null;
      state.workAreaEntryTime = null;
      state.workAreaExitStartedAt = null;
      state.workAreaExitTime = null;
    },
    setStatus(state, action) {
      const next = action.payload;
      // Accept any known automatic status (including legacy OFF_DUTY) so the
      // background tasks can drive the full state machine.
      if (!VALID_STATUSES.has(next)) return;
      state.status = next;
      // Entering the work area: record entry, clear any exit bookkeeping.
      if (next === DRIVER_STATUS.ACTIVE || next === DRIVER_STATUS.STAGED) {
        if (!state.workAreaEntryTime) state.workAreaEntryTime = Date.now();
        state.workAreaExitStartedAt = null;
      }
    },
    setLocation(state, action) {
      const { lat, lng, accuracy, speed, heading, acceleration, mocked } =
        action.payload;
      state.currentLat = lat;
      state.currentLng = lng;
      state.rawAccuracy = accuracy ?? state.rawAccuracy;
      if (mocked !== undefined) state.mocked = mocked === true;
      if (speed !== undefined) state.speed = speed;
      if (heading !== undefined) state.heading = heading;
      if (acceleration !== undefined) state.acceleration = acceleration;
    },
    setActiveSort(state, action) {
      state.activeSort = action.payload;
    },
    setTrackingEnabled(state, action) {
      state.trackingEnabled = !!action.payload;
      if (!action.payload) {
        state.status = DRIVER_STATUS.TRACKING_DISABLED;
        state.currentZoneId = null;
        state.isInsideZone = false;
        state.zoneEntryTime = null;
        state.workAreaExitStartedAt = null;
      }
    },
    setWorkAreaExitStartedAt(state, action) {
      state.workAreaExitStartedAt = action.payload ?? Date.now();
    },
    clearWorkAreaExitStartedAt(state) {
      state.workAreaExitStartedAt = null;
    },
    setCurrentZone(state, action) {
      // Generic zone setter used by the background active task. null clears it.
      const zoneId = action.payload ?? null;
      state.currentZoneId = zoneId;
      state.isInsideZone = !!zoneId;
      if (zoneId && !state.zoneEntryTime) state.zoneEntryTime = Date.now();
      if (!zoneId) state.zoneEntryTime = null;
    },
    zoneEntered(state, action) {
      state.currentZoneId = action.payload;
      state.isInsideZone = true;
      state.zoneEntryTime = Date.now();
    },
    zoneExited(state) {
      state.currentZoneId = null;
      state.isInsideZone = false;
      state.zoneEntryTime = null;
    },
    setGpsTier(state, action) {
      state.gpsTier = action.payload;
    },
  },
});

export const {
  setProfile,
  clearProfile,
  setStatus,
  setLocation,
  setActiveSort,
  setTrackingEnabled,
  setWorkAreaExitStartedAt,
  clearWorkAreaExitStartedAt,
  setCurrentZone,
  zoneEntered,
  zoneExited,
  setGpsTier,
} = driversSlice.actions;

export default driversSlice.reducer;
