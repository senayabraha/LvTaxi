import { createSlice } from '@reduxjs/toolkit';
import { SORT_OPTIONS } from '../lib/constants';

const initialState = {
  allZones: [],
  stats: {},
  top20Zones: [],
  activeSort: SORT_OPTIONS.NEAREST,
  loading: false,
  error: null,
};

const zonesSlice = createSlice({
  name: 'zones',
  initialState,
  reducers: {
    setZones(state, action) {
      state.allZones = action.payload;
    },
    setStats(state, action) {
      const map = {};
      for (const row of action.payload) {
        map[row.zone_id] = row;
      }
      state.stats = map;
    },
    updateZoneStat(state, action) {
      const row = action.payload;
      state.stats[row.zone_id] = row;
    },
    setSort(state, action) {
      state.activeSort = action.payload;
    },
    setTop20Zones(state, action) {
      state.top20Zones = action.payload;
    },
    setLoading(state, action) {
      state.loading = action.payload;
    },
    setError(state, action) {
      state.error = action.payload;
    },
  },
});

export const {
  setZones,
  setStats,
  updateZoneStat,
  setSort,
  setTop20Zones,
  setLoading,
  setError,
} = zonesSlice.actions;

export default zonesSlice.reducer;
