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
      const existing = state.stats[row.zone_id] ?? {};
      // Merge so the richer fields from the live-stats RPC (estimated_wait_*,
      // wait_confidence, median_dwell, etc.) survive leaner realtime events that
      // only carry the legacy zone_stats columns. For each enriched field, fall
      // back to the existing value when the incoming row omits it (null/undefined)
      // so a legacy update can't blank out a good live estimate and make the UI
      // flicker from a wait range back to the legacy wait_time_minutes.
      const preserve = (key) =>
        row[key] != null ? row[key] : existing[key];
      state.stats[row.zone_id] = {
        ...existing,
        ...row,
        estimated_wait_minutes: preserve('estimated_wait_minutes'),
        estimated_wait_min: preserve('estimated_wait_min'),
        estimated_wait_max: preserve('estimated_wait_max'),
        wait_confidence: preserve('wait_confidence'),
        wait_status: preserve('wait_status'),
        median_dwell_minutes: preserve('median_dwell_minutes'),
        dwell_sample_size: preserve('dwell_sample_size'),
        smoothed_service_rate_per_hour: preserve('smoothed_service_rate_per_hour'),
        last_updated: preserve('last_updated'),
      };
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
