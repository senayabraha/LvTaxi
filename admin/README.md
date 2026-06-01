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

## Tabs

Keyboard shortcuts `1`–`7` switch tabs.

| # | Tab | Purpose |
|---|-----|---------|
| 1 | **Live Ops** | Real-time zone health & wait confidence |
| 2 | **Zones** | Manage zones, polygons, toggles, config versions |
| 3 | **Drivers** | Driver roster, presence & classification |
| 4 | **Routes** | Manage saved training routes |
| 5 | **Builder** | Draw / track geofences |
| 6 | **Training** | Draw new reference routes for the ML model |
| 7 | **Audit** | Admin change history |

### Live Ops
Reads the `get_zone_live_stats()` RPC (presence-based live counts + blended
wait estimate). If the RPC is unavailable it falls back to `zone_stats` and
shows a warning banner. Summary cards plus a **Zone Health** table compute a
GOOD / WARNING / CRITICAL / UNKNOWN badge per zone (shared logic in
`src/lib/zoneHealth.js`, also used by the Zones table). Auto-refreshes every
15 s via polling — no extra realtime channels.

### Audit
Reads `zone_audit_log` (written by `src/lib/zoneStore.js` on every zone
change). Filter by zone name, field, and time range (24h / 7d / 30d / All);
newest first, capped at 200 rows. If the table is missing or RLS blocks the
read, a helpful message is shown instead of a crash. No rollback.

### Drivers
Joins `drivers` with `driver_presence` (and `staging_zones` for zone names).
Shows name, contact, role, status, current zone, classification, last
seen/ping, GPS accuracy and speed (App version column appears only if a
`drivers.app_version` column exists). Filter by Online / Stale / Off Duty /
Admin / Driver and search by name/email/phone. Online = pinged within 90 s,
Stale = within 30 min. Reading all drivers requires the `admin_read_all`
policy (migration 001) and `drivers.role = 'admin'`; otherwise a helpful RLS
message is shown. No promote/demote is provided.

### Routes (Training Routes Manager)
Lists saved `reference_routes` joined with `staging_zones`. Filter by zone,
route type and source; preview a route's drawn path on a Leaflet map; delete a
route (with confirmation). This is a manager for already-saved routes — the
**Training** tab remains the drawing tool.

### Zone config versions & restore
The Zones tab has a **🗂 Versions** button that opens a modal which lists
recent versions, saves new ones, and restores an earlier one.

- **What a version is** — an append-only snapshot of the *full* zone
  configuration (every zone's toggles + polygon JSON) stored in
  `zone_config_versions.snapshot`. Saved under the admin's JWT via RLS.
- **Save Version** — type optional notes and click 💾 Save Version. Inserts one
  immutable row; the live config is untouched.
- **Restore (rollback)** — click **↩ Restore** on a version. The modal computes
  a diff of that snapshot against the current `staging_zones` (matched by id,
  then by name) and shows: zones to **update** (with changed fields), zones to
  **create**, **unchanged** zones, and zones **not in the version**. Polygon
  fields are shown as `set` / `changed` / `missing` summaries, never raw JSON.
  You must type **`RESTORE`** to enable the confirm button.
- **On confirm** — existing zones are updated and missing zones inserted
  (sequentially, for an ordered audit trail); every change is written to
  `zone_audit_log` (created zones use `field = restored_created`, polygon
  changes use `polygon_*` summaries). The canonical snapshot is regenerated and
  a new version row noting `"Restore applied from version #N"` is appended.

**Safety**
- Restore is **never instant** — it always goes through preview + typed
  confirmation.
- Restore is **not transactional**; on a mid-process failure it stops and the
  UI honestly reports how many changes were already applied.
- Zones present now but **missing from the selected version are never deleted**
  — they are listed and left unchanged. Removing them stays a separate manual
  action.
- There is still **no admin promote/demote** and no super-admin role.

## Security
- The admin app uses the **publishable** Supabase key only — the same key as
  the mobile app. **Never** put a service role key in this frontend.
- All access is governed by Row Level Security. Admin-only data (audit log,
  full driver roster, zone versions) is gated by `is_admin(auth.uid())` /
  `admin_read_all` policies. New pages degrade gracefully (helpful message,
  no crash) when a table is missing or RLS blocks a read.

## Migrations
`supabase/migrations/015_zone_config_versions.sql` (Phase 2) — append-only
`zone_config_versions` table, RLS admin select/insert. Drivers and Routes pages
reuse existing tables/policies (`drivers`, `driver_presence`,
`reference_routes`). Phase 3 (restore) adds **no new migration** — it stores
full polygon JSON inside the existing `snapshot` column and reuses
`zone_audit_log`. Versions saved before Phase 3 lack polygon JSON, so a restore
of an old version leaves polygon fields untouched (it only restores what the
snapshot captured).

## Deploy (Vercel)
Set the project root to `/admin`, framework preset `Vite`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as env vars in the Vercel project settings.
