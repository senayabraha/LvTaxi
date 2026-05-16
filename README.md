# LvTaxi — Phase 1

React Native (Expo) app that brings DT5-style staging zone intelligence to every Las Vegas taxi driver's phone.

Phase 1 scope: project scaffold, Supabase auth (phone OTP + email), Supabase schema with RLS, seed data, and a working dark-themed home screen wired to live `zone_stats` via Supabase Realtime.

## Prerequisites

- Node.js 18+
- A Supabase project (https://supabase.com — free tier is fine)
- Expo Go on your phone, or Android Studio / Xcode for simulators

## 1. Install

```bash
cd C:\Users\senup\Documents\LvTaxi
npm install
```

## 2. Supabase setup

1. Create a project at https://supabase.com.
2. In the Supabase dashboard:
   - **SQL editor** → paste `supabase/schema.sql` → run.
   - **Authentication → Providers → Phone** → enable. Wire up Twilio (or your provider of choice) for SMS.
   - **Authentication → Providers → Email** → enable (default is fine).
3. Grab credentials from **Project settings → API**:
   - Project URL
   - `anon` public key
   - `service_role` key (used only by the seed script, never shipped to clients)

## 3. Environment

Copy `.env.example` to `.env` and fill in:

```
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

The `EXPO_PUBLIC_*` vars get inlined into the app bundle at build time. The service-role key is only read by the seed script.

## 4. Seed the database

```bash
npm run seed
```

This inserts all 15 LV staging zones and mock `zone_stats` so the UI is not empty on first launch.

## 5. Run

```bash
npm start
```

Then press `a` for Android, `i` for iOS, or scan the QR with Expo Go.

## Project structure

```
src/
  screens/
    SplashScreen.jsx     loading state while auth resolves
    AuthScreen.jsx       phone OTP + email login
    HomeScreen.jsx       sortable live zone list
    ProfileScreen.jsx    profile + status + sign out
  components/
    StatusToggle.jsx     Active / Staged / Off Duty / Browsing
    SortBar.jsx          Nearest / Flow / Wait
    ZoneListItem.jsx     one row in the zone list
  store/
    index.js             Redux store
    driversSlice.js      driver session, status, GPS
    zonesSlice.js        zones, stats, active sort
  lib/
    supabase.js          Supabase client (AsyncStorage-backed session)
    constants.js         15 LV staging zones, status + sort enums
  hooks/
    useAuth.js           session + profile + sign-in helpers
    useZones.js          loads zones + subscribes to zone_stats realtime

supabase/
  schema.sql             all 7 tables + RLS policies + realtime publication
scripts/
  seed.js                upserts 15 zones and mock stats (service-role)
```

## What works in Phase 1

- Splash → Auth → Tabs flow with persistent sessions (AsyncStorage)
- Phone OTP and email sign-in (sign-up included)
- `drivers` row auto-created on first sign-in
- Live zone list re-sorts when you tap Nearest / Flow / Wait
- `zone_stats` updates broadcast in real time across all clients

## What is *not* in Phase 1 (comes in Phase 2+)

- Actual GPS tracking (the screen reads `currentLat`/`currentLng` from Redux but nothing writes them yet)
- Kalman filter, geofencing, trajectory recording, classification
- Push notifications
- AI model

These slot into the existing Redux shape and `useZones` channel without changes to Phase 1 files.
