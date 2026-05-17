import { createSlice } from '@reduxjs/toolkit';
import { DRIVER_STATUS, SORT_OPTIONS } from '../lib/constants';

const initialState = {
  profile: null,
  status: DRIVER_STATUS.OFF_DUTY,
  currentLat: null,
  currentLng: null,
  rawAccuracy: null,
  speed: null,
  heading: null,
  acceleration: null,
  currentZoneId: null,
  isInsideZone: false,
  zoneEntryTime: null,
  activeSort: SORT_OPTIONS.NEAREST,
};

const driversSlice = createSlice({
  name: 'drivers',
  initialState,
  reducers: {
    setProfile(state, action) {
      state.profile = action.payload;
      if (action.payload?.status) {
        state.status = action.payload.status;
      }
    },
    clearProfile(state) {
      state.profile = null;
      state.status = DRIVER_STATUS.OFF_DUTY;
    },
    setStatus(state, action) {
      const next = action.payload;
      if (next !== DRIVER_STATUS.ACTIVE &&
          next !== DRIVER_STATUS.STAGED &&
          next !== DRIVER_STATUS.OFF_DUTY) {
        return;
      }
      state.status = next;
    },
    setLocation(state, action) {
      const { lat, lng, accuracy, speed, heading, acceleration } =
        action.payload;
      state.currentLat = lat;
      state.currentLng = lng;
      state.rawAccuracy = accuracy ?? state.rawAccuracy;
      if (speed !== undefined) state.speed = speed;
      if (heading !== undefined) state.heading = heading;
      if (acceleration !== undefined) state.acceleration = acceleration;
    },
    setActiveSort(state, action) {
      state.activeSort = action.payload;
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
  },
});

export const {
  setProfile,
  clearProfile,
  setStatus,
  setLocation,
  setActiveSort,
  zoneEntered,
  zoneExited,
} = driversSlice.actions;

export default driversSlice.reducer;
