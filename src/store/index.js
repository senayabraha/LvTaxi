import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import driversReducer from './driversSlice';
import zonesReducer from './zonesSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    drivers: driversReducer,
    zones: zonesReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredActions: ['auth/setSession'],
        ignoredPaths: ['auth.session'],
      },
    }),
});
