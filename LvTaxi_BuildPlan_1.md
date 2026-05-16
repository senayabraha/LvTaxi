# 🚕 LvTaxi — Full Product Build Plan

---

## 📋 App Overview

| | |
|---|---|
| **App Name** | LvTaxi |
| **Platform** | React Native (iOS + Android) |
| **Backend** | Supabase (Database + Realtime + Auth + Edge Functions) |
| **Language** | English |
| **Monetization** | Free at launch → Driver subscription later |
| **Target Users** | All Las Vegas taxi drivers (DT5 and non-DT5) |

---

## 🎯 Core Problem We Solve

The DT5 system shows staging zone data (cars, flow rate, wait time) but only to drivers with the physical DT5 unit installed. LvTaxi brings that same intelligence — and improves it — to any smartphone, for any Las Vegas taxi driver.

---

## 📍 Las Vegas Staging Zones (Seed Data)

| Zone | Approx Radius |
|---|---|
| Harry Reid T1 (pit) | 80m |
| Harry Reid T3 (pit) | 80m |
| Bellagio | 50m |
| Caesars Palace | 50m |
| MGM Grand | 50m |
| Mandalay Bay | 50m |
| Venetian | 50m |
| Aria / Vdara | 50m |
| Cosmopolitan | 40m |
| Aria Main (East) | 40m |
| Palazzo | 50m |
| Paris | 40m |
| Luxor | 50m |
| Fontainebleau | 50m |
| Resorts World (Conrad) | 50m |

> **Note:** Physical staging lanes are 5m wide × 20m long. Geofence radii are wider to account for GPS error. The AI behavioral engine filters out drop-offs and pass-throughs that fall inside the wider radius.

---

## 📱 Features

### Main Screen
- List view of all staging zones sorted by driver's preference
- Columns: **Cars | Flow (cars/hr) | Wait Time | Location**
- Color coding: 🟢 <10 mins | 🟡 10–20 mins | 🔴 >20 mins

### Sort Options
- 📍 **Nearest to me** — sorted by distance from driver's GPS
- ⚡ **Highest flow** — sorted by most rides per hour
- ⏱️ **Shortest wait** — sorted by estimated wait time
- Sort selection also determines which 20 geofences are actively monitored (iOS limit)

### Driver Status Toggle
- 🟢 Active — Currently driving
- 🅿️ Staged — Waiting at a zone
- 🔴 Off Duty — Not working
- 👀 Browsing — Just checking the app

### Smart Notifications
- Alerts driver when a zone within **0.5 miles** has a short wait
- Notification sent only when driver is Active or Browsing

### Authentication
- Phone number + SMS OTP (primary)
- Email (backup / account recovery)

---

## 🛰️ GPS & Location Engine

### Layer 1 — Dual-Frequency GPS (L1+L5)
- Uses `expo-location` with `Accuracy.BestForNavigation`
- Supported on iPhone XR+, Pixel 4+
- Accuracy: 1–3m open sky, 3–8m near Strip buildings
- Updates every 1 second / every 0.5 meters moved

### Layer 2 — Kalman Filter Smoothing
- Applied to every raw GPS reading
- Eliminates noise spikes and position jumps
- Reduces effective error by ~60–70%
- Library: `kalmanjs` (npm)

### Combined Accuracy
- Open areas (airport pits): ~1m
- Strip hotels: ~2–5m
- This error is acceptable because geofences are 40–80m radius and the AI behavioral engine handles fine-grained classification

---

## 🗺️ Geofencing Architecture

### Technology
- Native geofencing via `expo-location` + `expo-task-manager`
- Works in background even when app is closed
- iOS hard limit: 20 geofences maximum

### Dynamic 20-Zone Window
- The 20 actively monitored geofences always match the 20 zones currently displayed on screen
- As driver changes sort option or moves, geofences are swapped dynamically
- Geofences refresh on: sort change, driver moves 0.5 miles, zone data update, every 5 minutes

```
Sort: Nearest    → Monitor 20 closest zones geographically
Sort: Flow       → Monitor 20 highest flow zones
Sort: Wait       → Monitor 20 shortest wait zones
```

### Geofence Events
- **Enter event** → record arrival timestamp, begin trajectory recording
- **Exit event** → record departure, calculate dwell time, run AI classification

---

## 🧠 AI Behavioral Classification Engine

### Purpose
Distinguish between three visit types automatically:
- **STAGING** ✅ — count the driver in zone stats
- **DROP_OFF** ❌ — do not count
- **PASSING** ❌ — do not count

### GPS Trajectory Data (1 point per second)
```
{ timestamp, lat, lng, speed, heading, accuracy, acceleration }
```

### Behavioral Signals
| Signal | DROP_OFF | STAGING |
|---|---|---|
| Dwell time | <90 seconds | >3 minutes |
| Speed in zone | Stop-start pattern | Slow creep 0–3mph |
| Entry speed | High (15–30mph) | Low (5–10mph) |
| GPS point cluster | Sparse | Dense |
| Forward movement | None | Gradual |
| Exit acceleration | Fast | Gentle |
| Heading change | Straight through | Near reversal |

### Confidence Score Formula
Rule-based scoring in Phase 1:
- Score ≥ 70 → **STAGING** (count driver)
- Score ≤ 20 → **DROP_OFF** (ignore)
- Score 21–69 → **UNKNOWN** (prompt driver with one-tap confirm)

### AI Model (Phase 4+)
- Architecture: LSTM neural network
- Input: Full GPS trajectory (sequence of points)
- Output: Classification probabilities
- Training: Labeled trajectories from early users + driver confirmations
- Deployment: Supabase Edge Functions → later TensorFlow Lite on-device
- Accuracy progression:
  - Phase 1 (rules): ~88%
  - Phase 4 (AI, 2,000 labels): ~94%
  - Phase 5 (AI, 10,000+ labels): ~97–99%

---

## 📊 Zone Statistics Engine

### Real-Time Metrics Per Zone
| Metric | How Calculated |
|---|---|
| Cars staged | Count of STAGING drivers currently inside geofence |
| Flow rate (cars/hr) | Confirmed STAGING departures in last 60 minutes |
| Estimated wait | Cars staged ÷ Flow rate |
| Your queue position | Count of drivers who arrived before you |
| Your personal wait | Your position ÷ Flow rate |

### Data Flow
```
Driver enters geofence
  → Trajectory recording starts (1 GPS point/sec)
  → Behavioral scoring begins
  → If STAGING: add to zone car count via Supabase Realtime
  → All other drivers see updated count instantly
  → Driver exits geofence at speed > 5mph
  → Classified as LOAD event
  → Flow rate updated
  → Wait time recalculated
  → Broadcasted to all drivers
```

---

## 🗄️ Supabase Schema

```sql
drivers (
  id uuid PRIMARY KEY,
  phone text,
  email text,
  full_name text,
  status text,              -- active / staged / off_duty / browsing
  current_lat float,
  current_lng float,
  current_zone_id uuid,
  last_seen timestamp,
  subscription_tier text,   -- free / pro
  created_at timestamp
)

staging_zones (
  id uuid PRIMARY KEY,
  name text,
  lat float,
  lng float,
  radius_meters int,
  lane_width_meters float,  -- 5m
  lane_length_meters float, -- 20m
  active boolean,
  created_at timestamp
)

zone_stats (
  zone_id uuid PRIMARY KEY,
  cars_staged int,
  flow_rate_per_hour float,
  wait_time_minutes float,
  last_updated timestamp
)

zone_visits (
  id uuid PRIMARY KEY,
  driver_id uuid,
  zone_id uuid,
  entered_at timestamp,
  exited_at timestamp,
  dwell_seconds int,
  avg_speed float,
  entry_speed float,
  exit_speed float,
  heading_change float,
  forward_creep boolean,
  confidence_score int,
  classification text,      -- STAGING / DROP_OFF / PASSING / UNKNOWN
  driver_confirmed boolean,
  confirmed_label text
)

trajectories (
  id uuid PRIMARY KEY,
  visit_id uuid,
  gps_points jsonb,         -- array of GPS snapshots
  features jsonb,           -- extracted feature vector
  ai_classification text,
  ai_confidence float,
  ground_truth text,
  created_at timestamp
)

driver_zone_history (
  driver_id uuid,
  zone_id uuid,
  total_visits int,
  staging_count int,
  dropoff_count int,
  history_score int,        -- -25 to +25
  PRIMARY KEY (driver_id, zone_id)
)

notifications (
  id uuid PRIMARY KEY,
  driver_id uuid,
  zone_id uuid,
  type text,
  message text,
  sent_at timestamp,
  read boolean
)
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Mobile framework | React Native (Expo) |
| GPS & geofencing | expo-location, expo-task-manager |
| Kalman filter | kalmanjs (npm) |
| Auth | Supabase Auth (phone OTP + email) |
| Database | Supabase PostgreSQL |
| Real-time sync | Supabase Realtime |
| Push notifications | Expo Notifications + FCM/APNs |
| AI classification (P1) | Rule-based scoring (JavaScript) |
| AI classification (P4+) | LSTM model on Supabase Edge Functions |
| On-device AI (P5) | TensorFlow Lite |
| State management | Redux Toolkit |
| Navigation | React Navigation v6 |
| Maps (future) | Mapbox |

---

## 🚀 Launch Strategy

### Phase 1 — MVP (Months 1–2)
- Core app with GPS + Kalman filter
- Rule-based behavioral classification
- Real-time zone stats via Supabase
- Free for all drivers

### Phase 2 — Growth (Months 3–4)
- AI model trained on collected trajectory data
- Push notifications
- Driver history personalization
- Target: 100+ active Las Vegas drivers

### Phase 3 — Monetization (Month 5+)
- Pro subscription ($9–$15/month)
- Premium features: zone history trends, personal analytics, priority alerts
- Free tier: basic list view, 5-minute delayed data
- Pro tier: real-time data, notifications, AI-powered insights

---

---

# 🤖 AI BUILD PROMPTS

> Use these prompts sequentially with Claude AI or OpenAI Codex.
> Each prompt builds on the previous phase.

---

## PHASE 1 PROMPT — Project Scaffold + Auth + Supabase

```
Build a React Native app called LvTaxi using Expo.

TECH STACK:
- Expo SDK (latest)
- React Navigation v6 (stack + bottom tabs)
- Supabase JS client (@supabase/supabase-js)
- Redux Toolkit for state management
- NativeWind (Tailwind for React Native) for styling

PROJECT STRUCTURE:
/src
  /screens
    SplashScreen.jsx
    AuthScreen.jsx        ← phone OTP + email login
    HomeScreen.jsx        ← main staging list (placeholder)
    ProfileScreen.jsx     ← driver profile + status toggle
  /components
    StatusToggle.jsx      ← Active / Staged / Off Duty / Browsing
    ZoneListItem.jsx      ← single row: Cars | Flow | Wait | Location
    SortBar.jsx           ← Nearest / Flow / Wait sort options
  /store
    index.js              ← Redux store
    driversSlice.js       ← driver state
    zonesSlice.js         ← zone stats state
  /lib
    supabase.js           ← Supabase client init
    constants.js          ← staging zones array with lat/lng/radius
  /hooks
    useAuth.js
    useZones.js

SUPABASE SETUP:
Create all tables as defined in schema:
drivers, staging_zones, zone_stats, zone_visits, 
trajectories, driver_zone_history, notifications

AUTH FLOW:
1. User opens app → SplashScreen checks session
2. No session → AuthScreen
3. AuthScreen has two options:
   a. Phone number input → send OTP via Supabase phone auth
   b. Email + password
4. On successful auth → HomeScreen
5. Store session in Redux

STAGING ZONES CONSTANTS:
Pre-populate constants.js with all 15 Las Vegas staging zones:
Harry Reid T1 (pit), Harry Reid T3 (pit), Bellagio, 
Caesars Palace, MGM Grand, Mandalay Bay, Venetian, 
Aria/Vdara, Cosmopolitan, Aria Main (East), Palazzo, 
Paris, Luxor, Fontainebleau, Resorts World (Conrad)
Each with: id, name, lat, lng, radius (meters)

SEED DATABASE:
Write a seed script that inserts all 15 zones into 
the staging_zones table and initializes zone_stats 
with mock data so the UI is not empty.

OUTPUT:
Full file structure with working code for all files above.
App must run on both iOS and Android.
Auth must work end to end with Supabase.
```

---

## PHASE 2 PROMPT — GPS Engine + Kalman Filter + Geofencing

```
Extend the LvTaxi React Native app with the full 
GPS and geofencing engine.

PART A — KALMAN FILTER LOCATION SERVICE
Create /src/lib/locationEngine.js

Install: npm install kalmanjs

Implement:
1. KalmanLocationFilter class
   - Separate Kalman filter instances for lat and lng
   - R (measurement noise): 0.01
   - Q (process noise): 3
   - Method: filter(rawLat, rawLng) → { smoothedLat, smoothedLng }

2. startLocationTracking()
   - Request foreground + background location permissions
   - Use expo-location watchPositionAsync with:
     accuracy: Location.Accuracy.BestForNavigation
     timeInterval: 1000
     distanceInterval: 0.5
   - Apply Kalman filter to every raw GPS reading
   - Store smoothed position in Redux (driversSlice)
   - Calculate speed, heading, acceleration from consecutive points
   - Dispatch to Redux every second

3. getDistanceMeters(lat1, lng1, lat2, lng2)
   - Haversine formula
   - Returns distance in meters

PART B — DYNAMIC GEOFENCING
Create /src/lib/geofenceEngine.js

Install: expo-task-manager, expo-location

Implement:
1. GEOFENCE_TASK definition using TaskManager.defineTask
   - On Enter: dispatch zoneEntered(zoneId) to Redux
              record entry timestamp in Supabase zone_visits
              start trajectory recording
   - On Exit:  dispatch zoneExited(zoneId) to Redux
              record exit timestamp
              calculate dwell time
              pass trajectory to behavioral classifier

2. getTop20Zones(allZones, sortOption, driverLat, driverLng)
   - 'nearest' → sort by Haversine distance, take top 20
   - 'flow'    → sort by flowRate descending, take top 20
   - 'wait'    → sort by waitTimeMinutes ascending, take top 20
   - Returns array of 20 zone objects

3. updateActiveGeofences(top20Zones)
   - Stop existing geofencing: Location.stopGeofencingAsync()
   - Start new geofencing with top20Zones
   - Each geofence: { identifier: zone.id, latitude, longitude, radius }
   - notifyOnEnter: true, notifyOnExit: true

4. Auto-refresh triggers:
   - Driver changes sort option → updateActiveGeofences()
   - Driver moves 0.5 miles (nearest sort only) → updateActiveGeofences()
   - Every 5 minutes → updateActiveGeofences()

PART C — TRAJECTORY RECORDER
Create /src/lib/trajectoryRecorder.js

Implement:
1. startRecording(visitId)
   - Store GPS points array in memory
   - Every 1 second: push { timestamp, lat, lng, speed, heading, 
     accuracy, acceleration } to array

2. stopRecording()
   - Returns complete GPS points array
   - Saves raw trajectory to Supabase trajectories table

3. extractFeatures(gpsPoints)
   - Calculate: entrySpeed, exitSpeed, avgSpeedInZone, 
     maxSpeedInZone, dwellTime, timeStationary, 
     positionVariance, headingChange, forwardCreep,
     stopCount, entryAcceleration, exitAcceleration
   - Returns feature vector object

PART D — REDUX UPDATES
Update driversSlice.js to store:
- currentLat, currentLng (Kalman smoothed)
- rawAccuracy
- currentZoneId
- isInsideZone
- zoneEntryTime
- activeSort ('nearest' | 'flow' | 'wait')

Update zonesSlice.js to store:
- allZones array (from Supabase)
- top20Zones (computed from sort + driver position)
- Action: setSort(sortOption) → recalculates top20 + updates geofences
```

---

## PHASE 3 PROMPT — Main UI + Real-Time Zone Display

```
Build the complete HomeScreen UI for LvTaxi and connect 
it to Supabase Realtime for live zone data updates.

PART A — HOME SCREEN UI
Build /src/screens/HomeScreen.jsx

Design requirements:
- Dark theme (dark navy/black background)
- Matches the DT5 aesthetic but modern and mobile-first
- Professional, utilitarian, information-dense

Header:
- App name "LvTaxi" top left
- Driver status badge top right (colored dot + status text)
- Current time display

Sort Bar (below header):
- Three buttons: 📍 Nearest | ⚡ Flow | ⏱️ Wait
- Active sort highlighted in yellow/gold
- Tapping a sort updates Redux and triggers geofence refresh

Zone List:
- FlatList of ZoneListItem components
- Pull to refresh
- Each row shows:
  CARS  |  FLOW    |  WAIT     |  LOCATION
  20       94/hr     12 mins     MGM Grand    🟡

Color coding for wait time:
- 🟢 Green background: < 10 minutes
- 🟡 Yellow background: 10–20 minutes  
- 🔴 Red background: > 20 minutes

If driver is staged at a zone, that row is highlighted 
with a pulsing border and shows:
"📍 You are here — Position #8 — Your wait: ~12 mins"

PART B — ZONE LIST ITEM COMPONENT
Build /src/components/ZoneListItem.jsx

Props: { zone, isCurrentZone, driverPosition }

Show:
- Cars count (large number, left)
- Flow rate (cars/hr)
- Wait time (mins or "Xh Xm" for >60 mins)
- Location name
- Color-coded left border by wait time
- If isCurrentZone: show driver position badge

PART C — SUPABASE REALTIME CONNECTION
In /src/hooks/useZones.js implement:

1. Initial load: fetch all zones + zone_stats on mount

2. Supabase Realtime subscription to zone_stats table:
   supabase.channel('zone_stats_changes')
     .on('postgres_changes', 
         { event: 'UPDATE', schema: 'public', table: 'zone_stats' },
         (payload) => dispatch(updateZoneStat(payload.new))
     )
     .subscribe()

3. When zone_stats update arrives:
   - Update Redux zonesSlice
   - Recalculate sort order
   - Animate the changed row (brief flash)

4. On unmount: unsubscribe from channel

PART D — DRIVER STATUS TOGGLE
Build /src/components/StatusToggle.jsx

Four status options displayed as pill buttons:
🟢 Active | 🅿️ Staged | 🔴 Off Duty | 👀 Browsing

On status change:
- Update Redux driversSlice
- Update Supabase drivers table (status column)
- If switching to Off Duty: stop GPS tracking
- If switching to Active: start GPS tracking
- Change affects which notifications driver receives

PART E — ZONE STATS WRITE ENGINE
Create /src/lib/zoneStatsEngine.js

Functions:
1. incrementZoneCount(zoneId)
   - Increment cars_staged in zone_stats
   - Update last_updated timestamp

2. decrementZoneCount(zoneId)
   - Decrement cars_staged
   - Record departure as flow event
   - Recalculate flow_rate_per_hour:
     COUNT departures in last 60 minutes for this zone

3. recalculateWaitTime(zoneId)
   - wait_time_minutes = cars_staged / flow_rate_per_hour * 60
   - Update zone_stats
   - Supabase Realtime broadcasts to all drivers automatically
```

---

## PHASE 4 PROMPT — Behavioral Classification Engine

```
Build the behavioral classification engine for LvTaxi.
This engine analyzes GPS trajectory data to classify 
each zone visit as STAGING, DROP_OFF, or PASSING.

PART A — RULE-BASED CLASSIFIER
Create /src/lib/behavioralClassifier.js

Implement classifyVisit(features, driverHistory) → 
{ classification, confidence, score }

Scoring rules:

// DWELL TIME
if dwellSeconds < 90:      score -= 50
if dwellSeconds 90-180:    score += 0
if dwellSeconds 180-600:   score += 40
if dwellSeconds > 600:     score += 60

// SPEED PROFILE
if avgSpeedInZone > 10:    score -= 80  // passing through
if isStopStartPattern:     score -= 50  // drop-off signature
if avgSpeedInZone < 3:     score += 35  // staging creep
if timeStationary > 120:   score += 30  // stationary 2+ mins

// MOVEMENT PATTERN  
if exitedSameSide:         score -= 40  // passed through
if movedForwardGradually:  score += 40  // queue creep
if stoppedAtEntrance:      score -= 40  // drop-off
if positionVariance < 5:   score += 20  // barely moved

// ENTRY BEHAVIOR
if entrySpeed > 15:        score -= 20  // fast approach
if entryAcceleration < -2: score -= 15  // hard brake = drop-off
if entrySpeed < 8:         score += 20  // slow entry = staging

// DRIVER HISTORY (from driver_zone_history table)
score += driverHistory.historyScore  // -25 to +25

// TIME OF DAY
if isPeakStagingHour (6-10am, 8pm-2am):  score += 15

// CLASSIFICATION
if score >= 70:  return STAGING
if score <= 20:  return DROP_OFF
else:            return UNKNOWN

PART B — ZONE VISIT PROCESSOR
Create /src/lib/visitProcessor.js

processZoneExit(visitId, driverId, zoneId, gpsPoints):
1. Call trajectoryRecorder.extractFeatures(gpsPoints)
2. Load driverHistory from Supabase driver_zone_history
3. Call classifyVisit(features, driverHistory)
4. Save classification to zone_visits table
5. Save trajectory + features to trajectories table

If STAGING:
  - Call zoneStatsEngine.decrementZoneCount(zoneId)
  - Update driver_zone_history staging_count++
  - Calculate wait time experienced = exitTime - entryTime
  - Log completed staging event

If DROP_OFF or PASSING:
  - Do NOT update zone_stats (was never counted)
  - Update driver_zone_history dropoff_count++

If UNKNOWN:
  - Send one-tap confirmation notification to driver
  - "Were you staged at [Zone Name]? Yes / No"
  - On driver response: process as STAGING or DROP_OFF

PART C — CONFIRMATION NOTIFICATION
Create /src/lib/notificationService.js

sendStagingConfirmation(driverId, zoneName, visitId):
- Send push notification: 
  "Were you queued at [zoneName]?"
  Actions: [✅ Yes, I was staged] [❌ No, just dropped off]

handleConfirmationResponse(visitId, response):
- If YES: processAsStaging(visitId)
- If NO:  processAsDropoff(visitId)
- Save ground_truth to trajectories for AI training
- Update driver_zone_history

PART D — SMART DEFAULT SORT BY STATUS
In HomeScreen, when driver status changes:
- Status = Active (driving)   → auto-set sort to 'wait'
  (help them pick where to go next)
- Status = Staged             → auto-set sort to 'nearest'  
  (show surrounding zones)
- Status = Browsing           → auto-set sort to 'flow'
  (show most active zones)

PART E — TRAINING DATA COLLECTION
In visitProcessor.js, every confirmed classification:

saveTrainingData(visitId, confirmedLabel):
- Insert into trajectories table:
  { visit_id, gps_points, features, ground_truth: confirmedLabel }
- This data will be used in Phase 5 to train the AI model
- Log: driverID, zoneID, time_of_day, day_of_week for context
```

---

## PHASE 5 PROMPT — AI Model + Push Notifications + Polish

```
Finalize LvTaxi with AI-powered classification, 
push notifications, and production polish.

PART A — AI TRAJECTORY CLASSIFIER
Create Supabase Edge Function: classify-trajectory

Using the training data collected in Phase 4, implement 
a trajectory classification model.

For MVP use a decision tree / random forest approach
(no heavy ML framework needed):

1. Load training data from trajectories table where 
   ground_truth is not null

2. Build feature importance scoring from confirmed examples:
   - Which features best separate STAGING from DROP_OFF?
   - Weight features accordingly

3. classify(features) function:
   - Returns { classification, confidence }
   - Uses weighted feature scoring from training data
   - Falls back to rule-based classifier if < 100 training samples

4. Expose as POST endpoint:
   POST /functions/v1/classify-trajectory
   Body: { features: {...}, driverId: "..." }
   Response: { classification: "STAGING", confidence: 0.94 }

5. Call this endpoint from visitProcessor.js 
   instead of local rule-based classifier

PART B — PUSH NOTIFICATIONS ENGINE
Create /src/lib/notificationEngine.js

Install: expo-notifications

1. requestPermissions() on app launch
2. registerPushToken() → save to drivers table

3. Nearby Zone Alert:
   Background task runs every 2 minutes when driver is Active
   - Get driver's current position
   - Find all zones within 0.5 miles (804 meters)
   - If any zone has wait < 10 mins AND driver hasn't been 
     notified about this zone in last 30 mins:
     Send: "📍 [Zone Name] — only [X] mins wait, [N] cars staged"
   - Store notification in notifications table

4. Personal Queue Update:
   When driver is staged and their estimated wait changes 
   by more than 5 minutes:
   Send: "⏱️ Your wait at [Zone] updated: now ~[X] mins"

PART C — DRIVER ANALYTICS SCREEN
Build /src/screens/AnalyticsScreen.jsx

Show driver's personal stats:
- Total hours staged this week
- Average wait time per zone
- Best zones for this driver (by shortest personal wait)
- Rides loaded this week (estimated from staging completions)
- Favorite staging times / zones heatmap

Pull from zone_visits filtered by driver_id

PART D — PRODUCTION POLISH

1. Offline handling:
   - Cache last known zone_stats in AsyncStorage
   - Show "Last updated X mins ago" banner when offline
   - Retry connection automatically

2. Error boundaries:
   - GPS permission denied → clear instructions screen
   - Supabase connection error → retry with backoff
   - Classification failure → default to UNKNOWN flow

3. App performance:
   - FlatList with getItemLayout for smooth scrolling
   - Memoize ZoneListItem with React.memo
   - Debounce geofence updates (min 30 second gap)
   - Battery optimization: reduce GPS frequency to 5 seconds 
     when driver is stationary for > 10 minutes

4. Onboarding flow (first launch):
   Screen 1: "Real-time staging data for every LV taxi driver"
   Screen 2: "Set your status so your data helps everyone"
   Screen 3: "Get notified when a zone near you has a short wait"
   Screen 4: Phone/email signup

5. App Store preparation:
   - app.json with correct bundle IDs
   - Icons and splash screen (taxi yellow / dark theme)
   - Privacy policy URL (required for location permissions)
   - Location usage description strings for iOS
```

---

## 📅 Timeline

| Phase | Work | Duration |
|---|---|---|
| Phase 1 | Scaffold + Auth + Supabase | Week 1 |
| Phase 2 | GPS + Kalman + Geofencing | Week 2 |
| Phase 3 | Main UI + Real-time data | Week 3 |
| Phase 4 | Behavioral classifier | Week 4 |
| Phase 5 | AI model + Notifications + Polish | Week 5–6 |
| **Launch** | **Free beta to Las Vegas drivers** | **Week 7** |

---

## 💰 Monetization Roadmap

| Tier | Price | Features |
|---|---|---|
| Free | $0 | Basic list, 5-min delayed data, manual sort |
| Pro | $9.99/mo | Real-time data, notifications, analytics, AI insights |
| Fleet | TBD | Taxi company dashboard, fleet-wide stats |

---

*LvTaxi — Built by a Las Vegas taxi driver, for Las Vegas taxi drivers.*
