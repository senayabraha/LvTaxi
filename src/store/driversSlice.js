import { createSlice } from '@reduxjs/toolkit';
import { DRIVER_STATUS, SORT_OPTIONS } from '../lib/constants';

export const GUEST_MODE_KEY = 'lvtaxi_guest_mode';

const initialState = {
  session: null,
  profile: null,
  isGuest: false,
  status: DRIVER_STATUS.BROWSING,
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
    setSession(state, action) {
      state.session = action.payload;
      if (action.payload) state.isGuest = false;
    },
    setGuest(state, action) {
      state.isGuest = !!action.payload;
      if (action.payload) {
        state.session = null;
        state.profile = null;
      }
    },
    setProfile(state, action) {
      state.profile = action.payload;
      if (action.payload?.status) {
        state.status = action.payload.status;
      }
    },
    setStatus(state, action) {
      state.status = action.payload;
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
    signOut(state) {
      Object.assign(state, initialState);
    },
  },
});

export const {
  setSession,
  setGuest,
  setProfile,
  setStatus,
  setLocation,
  setActiveSort,
  zoneEntered,
  zoneExited,
  signOut,
} = driversSlice.actions;

export default driversSlice.reducer;
