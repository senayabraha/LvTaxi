import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  session: null,
  isLoading: true,
  isAdmin: false,
  passwordRecovery: false,
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
  },
});

export const {
  setSession,
  clearSession,
  setIsAdmin,
  setLoading,
  setPasswordRecovery,
} = authSlice.actions;
export default authSlice.reducer;
