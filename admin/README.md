# LvTaxi Admin

Minimal web dashboard for managing LvTaxi staging zones.

## Stack
- Vite + React 18
- Tailwind CSS
- @supabase/supabase-js

## Setup

```bash
cd admin
npm install
cp .env.example .env       # fill in VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev                # http://localhost:5173
```

The keys are the **same publishable key** as the mobile app. RLS limits what non-admins can see.

## Sign in
1. Sign in with your normal LvTaxi account (email + password)
2. In Supabase dashboard → Table editor → `drivers` → find your row → set `role = 'admin'`
3. Sign out + back in (the dashboard re-checks the role on sign-in)

## Features
- Live zone table with realtime updates from `zone_stats`
- Toggle `active` and `is_coming_soon` per zone (instant save)
- Filter by All / Active / Coming Soon / Phase A / Phase B
- Sort by Name / Cars / Wait
- Upload GeoJSON → preview → bulk import

## Deploy (Vercel)
Set the project root to `/admin`, framework preset `Vite`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as env vars in the Vercel project settings.
