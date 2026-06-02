# Mobile Admin — Real-Device QA Checklist

Manual QA for the LvTaxi admin dashboard after the mobile-first refactor.
Run through this on **real devices** (simulators miss Safari's dynamic toolbar
and safe-area behavior).

## Test matrix

| Device / browser | Notes |
|------------------|-------|
| iPhone — Safari | Primary target. Watch the dynamic bottom toolbar + home indicator. |
| iPhone — Chrome | Uses the same WebKit engine; confirm parity with Safari. |
| Android — Chrome | Confirm tab-bar scrolling + safe areas. |
| Desktop — Chrome/Safari | Confirm the layout still looks correct (no regressions). |

For each browser, test in **portrait and landscape**, and after **scrolling the
page down** (so Safari collapses its toolbar) to confirm bottom bars stay
reachable.

How to launch locally for device testing: see the **Testing** section in
`admin/README.md` (run `npm run dev -- --host` and open the LAN URL on the phone).

---

## 1. Shell: header + tab bar

- [ ] Header stays compact (~52px) and does not grow on small screens.
- [ ] Header shows the logo and the active section / zone counts.
- [ ] Tab bar is a **single row** and never wraps to multiple rows.
- [ ] Horizontal tab scrolling works (swipe left/right through all tabs).
- [ ] The active tab is visually highlighted in taxi-yellow.
- [ ] Selecting a tab off-screen keeps it usable (active tab remains visible/reachable).
- [ ] **More** menu opens, shows the account email, and Sign out works.
- [ ] Tapping outside the More menu closes it.
- [ ] Only two sticky layers are pinned (header + tab bar); page content scrolls under them.

## 2. Filters / controls (FilterBar)

- [ ] On mobile, filters are collapsed behind a **Filters** button with a summary line.
- [ ] Tapping **Filters** expands the full search / filter / sort / action controls.
- [ ] Tapping again collapses them.
- [ ] The summary text reflects the current selection (e.g. "All zones · Sort: Name").
- [ ] On desktop, filters are always expanded (no Filters button needed).
- [ ] Help text is collapsed behind **ⓘ Help** on mobile and expands on tap.

## 3. Metric strips

- [ ] Live Ops metric pills scroll horizontally on mobile.
- [ ] Drivers metric pills scroll horizontally on mobile.
- [ ] Pill values use the correct status colors (green/yellow/red/accent).
- [ ] On desktop, metrics render as larger cards.

## 4. Tables / cards readability

- [ ] **Zones** rows render as cards on mobile and are readable.
- [ ] Zone toggles (Active, Visible, Coming soon, Circle, Use Phase B) are tappable and save.
- [ ] **Drivers** cards are readable (name, status, zone, ping, accuracy/speed).
- [ ] **Routes** cards are readable (zone, type, source, points, recorded-at).
- [ ] **Audit** cards are readable (zone, field, old → new, time).
- [ ] **System** cards are readable (check, PASS/WARNING/FAIL, detail).
- [ ] Desktop still shows the full tables (cards are mobile-only).
- [ ] Where tables remain, the header is sticky inside its own scroll container.

## 5. Refresh / actions

- [ ] Refresh buttons work on Live Ops, Drivers, Routes, Audit, System.
- [ ] Zone CSV / GeoJSON export, Add Zone, Upload GeoJSON, and Versions buttons open/work.
- [ ] Route preview and delete (with confirm) work from the mobile cards.

## 6. Builder (map-first)

- [ ] The map uses the majority of the viewport height on mobile.
- [ ] The mode row (Track / Draw + GPS / Pts chips) stays compact at the top.
- [ ] The bottom **Controls** panel is collapsed by default on mobile and expands on tap.
- [ ] The bottom action panel does **not** cover important map controls
      (Satellite/Street toggle and "center on me" stay tappable).
- [ ] Drawing / tracking still works exactly as before (no behavior change).
- [ ] Save to Supabase still works from the expanded controls.

## 7. Training (map-first)

- [ ] The map is much taller than before and dominates the screen.
- [ ] Zone selector and route-type selector sit in a compact scrollable top row.
- [ ] Instructions are collapsed into **ⓘ Help** on mobile.
- [ ] The sticky bottom action bar shows points count, Clear, and Submit.
- [ ] The Submit button is **not** hidden behind Safari's bottom toolbar/home
      indicator (safe-area padding applied).
- [ ] Submitting a route still works exactly as before (no behavior change).

## 8. Safe area / Safari bottom bar

- [ ] No important button is hidden behind Safari's bottom browser bar.
- [ ] After scrolling (toolbar collapses) and at rest (toolbar expanded), the
      Training and Builder bottom bars remain fully tappable.
- [ ] Bottom action bars include `env(safe-area-inset-bottom)` spacing on devices
      with a home indicator (iPhone X+).

## 9. Scrolling / layering

- [ ] No page has a double-scroll problem (only one scroll region scrolls at a time).
- [ ] No sticky element overlaps or hides content.
- [ ] Horizontal scrolling (tab bar, metric strips, mobile top rows) is smooth and
      does not trigger whole-page horizontal scroll.
- [ ] Pull-to-refresh / rubber-banding does not break the fixed header or tab bar.

## 10. Orientation & desktop

- [ ] Landscape mode is acceptable on mobile (map pages still usable, bars not oversized).
- [ ] Rotating between portrait/landscape does not break layout heights (100dvh holds).
- [ ] Desktop layout is unchanged/correct: inline filters, full tables, larger cards.

## 11. Regression / non-goals

- [ ] No backend behavior changed: data, counts, and statuses match pre-refactor.
- [ ] Non-admin users are still blocked (auth/RLS unchanged).
- [ ] Supabase queries / RPCs / geofence drawing / route training are unchanged.

---

### Sign-off

| Item | iPhone Safari | iPhone Chrome | Android Chrome | Desktop |
|------|:---:|:---:|:---:|:---:|
| Shell / tabs | ☐ | ☐ | ☐ | ☐ |
| Filters / help | ☐ | ☐ | ☐ | ☐ |
| Metric strips | ☐ | ☐ | ☐ | ☐ |
| Tables / cards | ☐ | ☐ | ☐ | ☐ |
| Builder map-first | ☐ | ☐ | ☐ | ☐ |
| Training map-first | ☐ | ☐ | ☐ | ☐ |
| Safe area | ☐ | ☐ | n/a | n/a |
| Landscape | ☐ | ☐ | ☐ | n/a |

Tester: ______________   Date: __________   Build/commit: __________
