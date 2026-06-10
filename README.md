# LvTaxi

Expo/Supabase app for Las Vegas taxi staging intelligence: live staging-zone
counts, wait estimates, geofence-backed driver presence, visit history, and
driver/admin operations.

## Prerequisites

- Node.js 18+
- A Supabase project
- Expo Go, an Expo development build, or Android Studio / Xcode simulators

## 1. Install

```bash
cd C:\Users\senup\Documents\LvTaxi
npm install
```

## 2. Supabase Setup

Create a Supabase project, then apply the database migrations in
`supabase/migrations/` in filename order.

Do not set up a new database by running only `supabase/schema.sql`. That file is
a historical Phase-1 baseline and is missing the current `driver_presence`
schema, live-stats RPC/snapshot objects, work areas, geofence/eligibility
columns, and migrations `001` through the latest migration.

Preferred local flow:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Dashboard-only flow:

1. Open Supabase **SQL editor**.
2. Run each file in `supabase/migrations/` in filename order, starting with
   `001_add_auth_columns.sql` and continuing through the latest migration.
3. Confirm the migration history in the Supabase dashboard before running the
   app.

Migration naming convention:

- `001` through `024` are legacy numeric migrations that already exist.
- New migrations from `025` onward use a UTC timestamp prefix:
  `YYYYMMDDHHMMSS_short_description.sql`.
- Keep migrations append-only. Do not edit or re-run `supabase/schema.sql` for
  current setup.

In the Supabase dashboard, also enable:

- **Authentication -> Providers -> Phone** with your SMS provider.
- **Authentication -> Providers -> Email**.

Grab credentials from **Project settings -> API**:

- Project URL
- `publishable` key (formerly `anon` public)
- `secret` key (formerly `service_role`; used only by scripts, never shipped to clients)

## 3. Environment

Copy `.env.example` to `.env` and fill in:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

The `EXPO_PUBLIC_*` variables are inlined into the app bundle at build time. The
secret key is only read by scripts.

## 4. Seed the Database

```bash
npm run seed
```

This upserts the LV staging zones and initial stats rows.

## 5. Run

```bash
npm start
```

Then press `a` for Android, `i` for iOS, or scan the QR code with Expo Go.

## Project Structure

```text
src/
  components/            React Native UI components
  hooks/                 app data hooks, including zone/stat loading
  lib/                   Supabase, GPS, geofence, presence, and visit logic
  screens/               app screens
  store/                 Redux slices

supabase/
  migrations/            required database setup; run in filename order
  schema.sql             historical Phase-1 baseline, not current setup
  functions/             Supabase Edge Functions

scripts/
  seed.js                upserts staging zones and mock stats
```
