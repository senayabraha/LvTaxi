import { configureStore } from '@reduxjs/toolkit';
import driversReducer from './driversSlice';
import zonesReducer from './zonesSlice';

export const store = configureStore({
  reducer: {
    drivers: driversReducer,
    zones: zonesReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredActions: ['drivers/setSession'],
        ignoredPaths: ['drivers.session'],
      },
    }),
});
