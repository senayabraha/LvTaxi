import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  session: null,
  isLoading: true,
  isAdmin: false,
  passwordRecovery: false,
  // True while a profile fetch is in-flight (including retry attempts).
  // Root uses this to show a reconnecting screen instead of AuthStack when a
  // session exists but the profile hasn't loaded yet (LIFE-4).
  profileFetching: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setSession(state, action) {
      state.session = action.payload;
    },
    clearSession(state) {
      state.session = null;
      state.isAdmin = false;
      state.passwordRecovery = false;
    },
    setIsAdmin(state, action) {
      state.isAdmin = !!action.payload;
    },
    setLoading(state, action) {
      state.isLoading = !!action.payload;
    },
    setPasswordRecovery(state, action) {
      state.passwordRecovery = !!action.payload;
    },
    setProfileFetching(state, action) {
      state.profileFetching = !!action.payload;
    },
  },
});

export const {
  setSession,
  clearSession,
  setIsAdmin,
  setLoading,
  setPasswordRecovery,
  setProfileFetching,
} = authSlice.actions;
export default authSlice.reducer;
