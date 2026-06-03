# Phase 5 TODO: Driver Notification Preferences

Status: Not started
Owner: LV Taxi app/admin
Depends on:
- Phase 1: Supabase notification schema verified
- Phase 2: Driver `push_token` saving verified
- Phase 3: `send-push` Supabase Edge Function working
- Phase 4: Admin announcement screen added

## Goal

Give drivers control over what notifications they receive so LV Taxi stays useful without becoming annoying.

## Recommended scope

### 1. Add notification preferences table

Create a migration for driver-level preferences.

```sql
create table if not exists driver_notification_preferences (
  driver_id uuid primary key references drivers(id) on delete cascade,
  nearby_short_wait boolean default true,
  queue_updates boolean default true,
  admin_announcements boolean default true,
  staging_confirmations boolean default true,
  quiet_hours_enabled boolean default false,
  quiet_hours_start time,
  quiet_hours_end time,
  updated_at timestamptz default now()
);

alter table driver_notification_preferences enable row level security;

drop policy if exists "notification prefs self" on driver_notification_preferences;

create policy "notification prefs self"
  on driver_notification_preferences for all
  to authenticated
  using (auth.uid() = driver_id)
  with check (auth.uid() = driver_id);
```

### 2. Add default preference creation

When a driver profile is created or loaded, ensure a preference row exists.

Preferred behavior:
- If no row exists, create one with default values.
- Do not overwrite existing driver choices.

### 3. Add driver-facing controls in mobile Profile screen

Add a new section in `src/screens/ProfileScreen.jsx`:

- Nearby short-wait alerts
- Queue update alerts
- Admin announcements
- Staging confirmations
- Quiet hours toggle
- Quiet hours start/end time

Keep the UI simple and mobile friendly.

### 4. Apply preferences in local notification logic

Update:

- `src/lib/notificationEngine.js`
- `src/lib/notificationService.js`

Rules:
- Do not send nearby short-wait notification if `nearby_short_wait = false`.
- Do not send queue update notification if `queue_updates = false`.
- Do not send staging confirmation if `staging_confirmations = false`.
- Respect quiet hours for non-critical notifications.

### 5. Apply preferences in backend push sender

Update:

- `supabase/functions/send-push/index.ts`

Rules:
- Admin announcements should skip drivers where `admin_announcements = false`.
- Quiet hours should be respected unless the future request includes an emergency/critical flag.
- Keep current admin role check.

### 6. Add admin visibility later

Optional later enhancement for admin dashboard:
- Show whether a driver has push token enabled.
- Show notification preference summary in Drivers page.
- Allow admin to see, but not override, driver notification preferences.

## Acceptance checklist

- [ ] Migration exists for `driver_notification_preferences`.
- [ ] RLS allows each driver to manage only their own preferences.
- [ ] Profile screen shows notification preference toggles.
- [ ] Preferences save successfully to Supabase.
- [ ] Local nearby alerts obey preferences.
- [ ] Local queue updates obey preferences.
- [ ] Staging confirmations obey preferences.
- [ ] Admin announcements obey preferences in `send-push`.
- [ ] Quiet hours work for non-critical notifications.
- [ ] App does not crash if preference row is missing.
- [ ] Defaults are created or safely assumed.

## Notes

Start with simple booleans first. Do not overbuild scheduling, categories, or emergency alerts until the basic preferences are stable.
