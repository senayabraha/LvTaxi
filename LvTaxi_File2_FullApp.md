# 🚕 LvTaxi — File 2: Full App Plan
## Geofencing + Zone Stats + Behavioral Engine + UI + Admin

---

# 📋 OVERVIEW

This file covers everything in LvTaxi except authentication
(which is in File 1). All decisions below are finalized
from the 17-question planning session.

---

# 🗺️ GEOFENCING SYSTEM

## Two-Phase Strategy

```
PHASE A (LAUNCH DAY)              PHASE B (MONTH 1-2)
────────────────────              ────────────────────
24 zones imported from            Admin drives each lane
geojson.io GeoJSON file           GPS track recorded
                                  Kalman smoothed
Drawn polygons stored             Turf.js 4m buffer
in Supabase                       Precise polygon created
                                  
Detection: point-in-polygon       Detection: point-in-polygon
+ 3 minute dwell rule             + behavioral AI engine
                                  
~75% accuracy                     ~97% accuracy
Active immediately ✅             Upgrades zone by zone ✅
```

## Zone Count Rule (Both Phases)
```
ANY device inside a geofenced polygon for 3+ consecutive
minutes is counted as staged — regardless of toggle state.

Green toggle (driving) = counted ✅
Grey toggle (off duty) = ALSO counted ✅

The toggle only controls GPS frequency + notifications.
It never excludes a device from zone counting.
```

---

# 🗄️ SUPABASE SCHEMA

```sql
-- ─────────────────────────────────────────
-- STAGING ZONES
-- ─────────────────────────────────────────
CREATE TABLE staging_zones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,

  -- Phase A: drawn polygon from geojson.io
  drawn_polygon         jsonb,
  drawn_coordinates     jsonb,

  -- Phase B: driven polygon from Zone Creator
  driven_polygon        jsonb,
  driven_coordinates    jsonb,
  buffer_meters         float DEFAULT 4.0,
  track_points          int,
  avg_gps_accuracy      float,
  track_length_meters   float,

  -- Which polygon is active
  use_driven_polygon    boolean DEFAULT false,
  -- false = use drawn_polygon (Phase A)
  -- true  = use driven_polygon (Phase B)

  -- Visibility
  active                boolean DEFAULT true,
  visible_to_drivers    boolean DEFAULT true,
  -- Admin toggles this in dashboard
  -- false = shows as "Coming Soon" to drivers
  is_coming_soon        boolean DEFAULT false,

  -- Audit
  recorded_by           uuid REFERENCES drivers(id),
  created_at            timestamp DEFAULT now(),
  updated_at            timestamp DEFAULT now()
);

-- ─────────────────────────────────────────
-- ZONE STATISTICS (live data)
-- ─────────────────────────────────────────
CREATE TABLE zone_stats (
  zone_id               uuid PRIMARY KEY REFERENCES staging_zones(id),
  cars_staged           int DEFAULT 0,
  flow_rate_per_hour    float DEFAULT 0,
  wait_time_minutes     float,
  -- NULL = no data, show "?" in app
  last_updated          timestamp DEFAULT now()
);

-- ─────────────────────────────────────────
-- LOAD EVENTS (for flow rate calculation)
-- ─────────────────────────────────────────
CREATE TABLE load_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id               uuid REFERENCES staging_zones(id),
  occurred_at           timestamp DEFAULT now()
);

-- ─────────────────────────────────────────
-- ZONE VISITS (behavioral tracking)
-- ─────────────────────────────────────────
CREATE TABLE zone_visits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             uuid REFERENCES drivers(id),
  zone_id               uuid REFERENCES staging_zones(id),
  entered_at            timestamp,
  exited_at             timestamp,
  dwell_seconds         int,
  avg_speed             float,
  entry_speed           float,
  exit_speed            float,
  heading_change        float,
  forward_creep         boolean,
  confidence_score      int,
  classification        text,
  -- STAGING / DROP_OFF / PASSING / UNKNOWN
  driver_confirmed      boolean DEFAULT false
);

-- ─────────────────────────────────────────
-- GPS TRAJECTORIES (for AI training)
-- ─────────────────────────────────────────
CREATE TABLE trajectories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id              uuid REFERENCES zone_visits(id),
  gps_points            jsonb,
  features              jsonb,
  ai_classification     text,
  ai_confidence         float,
  ground_truth          text,
  created_at            timestamp DEFAULT now()
);

-- ─────────────────────────────────────────
-- DRIVER ZONE HISTORY
-- ─────────────────────────────────────────
CREATE TABLE driver_zone_history (
  driver_id             uuid REFERENCES drivers(id),
  zone_id               uuid REFERENCES staging_zones(id),
  total_visits          int DEFAULT 0,
  staging_count         int DEFAULT 0,
  dropoff_count         int DEFAULT 0,
  history_score         int DEFAULT 0,
  -- -25 to +25, used in behavioral scoring
  PRIMARY KEY (driver_id, zone_id)
);

-- ─────────────────────────────────────────
-- ZONE TRACKS (raw GPS from drive-recording)
-- ─────────────────────────────────────────
CREATE TABLE zone_tracks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id               uuid REFERENCES staging_zones(id),
  raw_gps_points        jsonb,
  smoothed_points       jsonb,
  recorded_at           timestamp DEFAULT now()
);

-- ─────────────────────────────────────────
-- STORED PROCEDURES
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_zone_count(p_zone_id uuid)
RETURNS void AS $$
  UPDATE zone_stats
  SET cars_staged = cars_staged + 1,
      last_updated = now()
  WHERE zone_id = p_zone_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION decrement_zone_count(p_zone_id uuid)
RETURNS void AS $$
  UPDATE zone_stats
  SET cars_staged = GREATEST(cars_staged - 1, 0),
      last_updated = now()
  WHERE zone_id = p_zone_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION record_load_event(p_zone_id uuid)
RETURNS void AS $$
BEGIN
  INSERT INTO load_events (zone_id) VALUES (p_zone_id);
  -- Recalculate flow rate: loads in last 60 minutes
  UPDATE zone_stats
  SET flow_rate_per_hour = (
    SELECT COUNT(*) FROM load_events
    WHERE zone_id = p_zone_id
    AND occurred_at > now() - interval '1 hour'
  ),
  last_updated = now()
  WHERE zone_id = p_zone_id;
  -- Recalculate wait time
  UPDATE zone_stats
  SET wait_time_minutes = CASE
    WHEN flow_rate_per_hour > 0
    THEN (cars_staged::float / flow_rate_per_hour) * 60
    ELSE NULL  -- NULL = show "?" in app
  END
  WHERE zone_id = p_zone_id;
END;
$$ LANGUAGE plpgsql;
```

---

# 📊 ZONE STATISTICS ENGINE

## Wait Time Calculation
```
Wait Minutes = (Cars Staged ÷ Flow Rate per Hour) × 60

Example:
  20 cars staged ÷ 108 loads/hr × 60 = 11.1 mins ✅

No flow data → wait_time_minutes = NULL → show "?" in app
  Sort "?" zones to BOTTOM of list always
```

## Flow Rate Calculation
```
Flow Rate = COUNT of load_events in last 60 minutes
            for this specific zone

Updates automatically every time a car loads
via record_load_event() stored procedure
```

## Real-Time Broadcast
```
Supabase Realtime watches zone_stats table
Any UPDATE → instantly broadcasts to ALL connected drivers
All drivers see new car counts and wait times within ~200ms
```

---

# 📱 MAIN SCREEN UI

## Layout
```
┌──────────────────────────────────────────┐
│  🚕 LvTaxi        [🟢 Driving ●──────]  │
├──────────────────────────────────────────┤
│  Sort: [⏱️ Wait ✅] [⚡ Flow] [📍 Near] │
├──────┬──────────┬──────────┬─────────────┤
│ CARS │  FLOW    │   WAIT   │  LOCATION   │
├──────┼──────────┼──────────┼─────────────┤
│  8   │  74/hr   │  6 mins  │ Aria Main  🟢│
│  7   │  65/hr   │  6 mins  │ Park MGM   🟢│
│  20  │  94/hr   │  12 mins │ MGM Grand  🟡│
│  43  │ 109/hr   │  23 mins │ Caesars    🔴│
│  12  │  51/hr   │  14 mins │ Luxor      🟡│
│  15  │   0/hr   │    ?     │ Bellagio   ⚫│
│  --  │   --     │   --     │ Cosmopolitan│
│      │          │ Coming   │    soon     │
└──────┴──────────┴──────────┴─────────────┘
```

## Color Coding
```
🟢 Green row background:  wait < 10 minutes
🟡 Yellow row background: wait 10–20 minutes
🔴 Red row background:    wait > 20 minutes
⚫ Grey row:              wait = "?" (no flow data)
── Placeholder row:       Coming Soon zone
```

## Default Sort
```
App ALWAYS opens with Shortest Wait sort.
No memory of last sort. Every session starts fresh.

Sort options:
  ⏱️ Shortest Wait  → ascending wait_time_minutes
                       NULL/"?" zones always at bottom
  ⚡ Highest Flow   → descending flow_rate_per_hour
  📍 Nearest to Me  → ascending distance from driver GPS
```

## Coming Soon Zones
```
All 13 unmapped zones shown as placeholder rows:
  Grayed out styling
  Text: "[Zone Name] — Coming Soon"
  No stats columns
  Always sorted to very bottom regardless of sort option
  
Admin can toggle any zone's is_coming_soon flag
in the admin dashboard to show/hide placeholder
```

## Driver's Own Zone (when staged)
```
If driver is inside a zone:
  That row highlighted with pulsing gold border
  Shows: "📍 You are here — Est. wait: 12 mins"
  Stays visible at top of list regardless of sort
```

---

# 🛰️ GPS & LOCATION ENGINE

## Layer 1 — Dual Frequency GPS
```javascript
// FILE: /src/lib/locationEngine.js

import * as Location from 'expo-location'

// High frequency (green toggle = driving)
setHighFrequency() {
  watchPositionAsync({
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,      // every 1 second
    distanceInterval: 0.5    // or every 0.5 meters
  })
}

// Low frequency (grey toggle = off duty)
// Still tracks for zone counting
setLowFrequency() {
  watchPositionAsync({
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 30000,     // every 30 seconds
    distanceInterval: 5      // or every 5 meters
  })
}

// Battery saver (stationary 10+ mins inside zone)
setIdleFrequency() {
  watchPositionAsync({
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 5000,      // every 5 seconds
    distanceInterval: 2
  })
}
```

## Layer 2 — Kalman Filter
```javascript
// Applied to every raw GPS reading
// Reduces noise by 60-70%
// Library: kalmanjs (npm)

const kf = new GPSKalmanFilter({ R: 0.01, Q: 3 })
const smoothed = kf.filter(rawLat, rawLng)
// smoothed.lat + smoothed.lng = clean position
```

## Combined Accuracy
```
Open areas (airport pits):        ~1m
Strip hotels (near buildings):    ~2–5m
Geofence zones are 40–200m wide   → error is negligible
Detection accuracy:               ~97%
```

---

# 🗺️ ZONE DETECTION ENGINE

## Polygon Detection (Both Phases)
```javascript
// FILE: /src/lib/zoneDetector.js

function detectCurrentZone(smoothedLat, smoothedLng, zones) {
  const point = turf.point([smoothedLng, smoothedLat])

  // Performance: pre-filter zones within 500m
  const nearby = zones.filter(zone => {
    const center = getZoneCenter(zone)
    return getDistanceMeters(
      smoothedLat, smoothedLng,
      center.lat, center.lng
    ) < 500
  })

  // Check each nearby zone
  return nearby.find(zone => {
    const polygon = zone.use_driven_polygon
      ? zone.driven_polygon    // Phase B
      : zone.drawn_polygon     // Phase A
    return turf.booleanPointInPolygon(point, polygon)
  }) || null
}
```

## Debounce (3-Minute Rule)
```javascript
// Driver must be inside zone for 3 consecutive minutes
// before being counted as staged

const STAGE_THRESHOLD_MS = 180000 // 3 minutes

let zoneEntryTime = null

onZoneDetected(zone) {
  if (!zoneEntryTime) {
    zoneEntryTime = Date.now()
    startTrajectoryRecording()
  }

  const dwellTime = Date.now() - zoneEntryTime

  if (dwellTime >= STAGE_THRESHOLD_MS && !isCountedAsStaged) {
    isCountedAsStaged = true
    supabase.rpc('increment_zone_count', { p_zone_id: zone.id })
    updateDriverZone(zone.id)
  }
}

onZoneExited() {
  zoneEntryTime = null
  isCountedAsStaged = false
  processZoneExit()
}
```

---

# 🧠 BEHAVIORAL CLASSIFICATION ENGINE

Active from day one. Rule-based scoring.
Classifies every zone visit automatically.

## Classifications
```
STAGING   ✅  Count the departure as a load event
DROP_OFF  ❌  Don't count as load event
PASSING   ❌  Don't count as load event
UNKNOWN   ❓  Ask driver with one-tap notification
```

## Scoring Rules
```javascript
// FILE: /src/lib/behavioralClassifier.js

function classifyVisit(features, driverHistory) {
  let score = 0

  // ── DWELL TIME ──────────────────────────
  if (features.dwellSeconds < 90)        score -= 50
  else if (features.dwellSeconds < 180)  score += 0
  else if (features.dwellSeconds < 600)  score += 40
  else                                   score += 60

  // ── SPEED PROFILE ───────────────────────
  if (features.avgSpeedInZone > 10)      score -= 80
  if (features.isStopStartPattern)       score -= 50
  if (features.avgSpeedInZone < 3)       score += 35
  if (features.timeStationary > 120)     score += 30

  // ── MOVEMENT PATTERN ────────────────────
  if (features.exitedSameSide)           score -= 40
  if (features.movedForwardGradually)    score += 40
  if (features.stoppedAtEntrance)        score -= 40
  if (features.positionVariance < 5)     score += 20

  // ── ENTRY BEHAVIOR ──────────────────────
  if (features.entrySpeed > 15)          score -= 20
  if (features.entryAcceleration < -2)   score -= 15
  if (features.entrySpeed < 8)           score += 20

  // ── DRIVER HISTORY ──────────────────────
  score += driverHistory.historyScore  // -25 to +25

  // ── TIME OF DAY ─────────────────────────
  const hour = new Date().getHours()
  const isPeak = (hour >= 6 && hour <= 10) ||
                 (hour >= 20 && hour <= 26)
  if (isPeak) score += 15

  // ── CLASSIFICATION ──────────────────────
  if (score >= 70)  return { classification: 'STAGING',  score }
  if (score <= 20)  return { classification: 'DROP_OFF', score }
  return { classification: 'UNKNOWN', score }
}
```

## UNKNOWN Handler
```
If classification = UNKNOWN:
  Send push notification to driver:
  "Were you queued at [Zone Name]?"
  [ ✅ Yes, I was staged ]  [ ❌ No, just dropped off ]
  
  Timeout: 5 minutes
  If no response → classify as DROP_OFF
  
  Driver response saved as ground truth for future AI training
```

---

# 📲 PUSH NOTIFICATIONS

## Trigger Rules
```
Alert fires when ALL conditions are true:
  ✓ Zone within 0.5 miles of driver's current position
  ✓ Zone wait time < 5 minutes
  ✓ Driver has green toggle (actively driving)
  ✓ Driver not already staged in a zone
  ✓ Same zone not notified in last 30 minutes
```

## Notification Format
```
Title: "🚕 Short wait nearby"
Body:  "Aria Main — only 4 mins wait, 8 cars staged"
Tap:   Opens app to main screen with that zone highlighted
```

## Implementation
```javascript
// Background task checks every 2 minutes
// Only when toggle is green

async function checkNearbyZones(driverLat, driverLng) {
  const zones = await zoneCache.getZones()
  const stats = await loadZoneStats()

  const candidates = zones.filter(zone => {
    const center = getZoneCenter(zone)
    const dist = getDistanceMeters(
      driverLat, driverLng, center.lat, center.lng
    )
    const stat = stats.find(s => s.zone_id === zone.id)
    const waitTime = stat?.wait_time_minutes

    return dist <= 804              // 0.5 miles in meters
      && waitTime !== null          // has real data
      && waitTime < 5               // under 5 minutes
      && !recentlyNotified(zone.id) // not notified recently
  })

  if (candidates.length > 0) {
    const best = candidates.sort((a,b) =>
      getWait(a) - getWait(b)
    )[0]
    sendPushNotification(best)
    markNotified(best.id)
  }
}
```

---

# 🛠️ ADMIN DASHBOARD (admin.lvtaxi.com)

## Tech Stack
```
React 18 + Vite
Mapbox GL JS (satellite-streets style)
@turf/turf
@supabase/supabase-js
Tailwind CSS
Deploy: Vercel
```

## Features
```
✅ View all zones on satellite map
✅ Draw new zones by clicking polygon corners
✅ Edit existing polygon vertices (drag to adjust)
✅ Adjust buffer size with live preview
✅ Enable / disable individual zones
✅ Toggle zone visibility (active vs coming soon)
✅ Upload GeoJSON file → auto-import zones
✅ Export all zones as GeoJSON backup
```

## GeoJSON Upload & Import
```
Admin clicks [Upload GeoJSON]
→ File picker opens (.geojson or .json)
→ App parses the file
→ For each Feature:
    Extract name from properties.Name or properties.name
    Extract polygon coordinates
    Insert to Supabase staging_zones
    Insert to zone_stats with zeros
    Insert to zone_tracks if has track data
→ Show import summary:
    "✅ Imported 24 zones successfully"
    "⚠️ 2 zones skipped (already exist)"
→ Map updates instantly with new polygons

IMPORT SCRIPT (also runs as CLI):
  node scripts/importGeoJSON.js lvtaxi_zones.geojson
```

## Map Display Rules
```
ACTIVE zones:
  Fill: #F5C518 (gold), opacity 0.3
  Border: #F5C518, width 2px

COMING SOON zones:
  Fill: #6B7280 (grey), opacity 0.2
  Border: #6B7280, dashed

SELECTED zone:
  Fill opacity: 0.5
  Border width: 3px
  Show vertex handles for editing

Phase A zones: solid border
Phase B zones: solid border + small "B" badge on map
```

## Zone Details Panel
```
Zone name (editable inline)
Phase badge: 🟡 Phase A | 🟢 Phase B
Active toggle (on/off)
Visible to drivers toggle (on/off)
Coming soon toggle (on/off)
Buffer slider: 2m ←——●——→ 6m

Stats:
  Cars staged right now: [live count]
  Flow rate: [cars/hr]
  Wait time: [mins or ?]
  Total visits today: [count]

Actions:
  [✏️ Edit Polygon]
  [📋 Copy GeoJSON]
  [🗑️ Delete Zone]
```

---

# 📱 ZONE CREATOR SCREEN (Phase B — Admin Only)

## Access
```
Only visible in app if driver.role === 'admin'
Shows in profile screen under "Admin Tools"
```

## Screen Flow
```
ZONE SELECTOR → READY → RECORDING → PREVIEW → SAVED

ZONE SELECTOR:
  List of all zones with phase status
  🟡 Phase A → tap to record
  🟢 Phase B → already recorded (can re-record)

READY STATE:
  Satellite map showing current position
  Phase A polygon shown as dashed overlay
  GPS accuracy indicator
  Buffer selector: [2m][3m][4m ✅][5m]
  [⏺ START RECORDING] button

RECORDING STATE:
  Live red GPS track on satellite map
  Live stats: points, accuracy, distance, duration
  [⏹ STOP] button only (no other navigation)

PREVIEW STATE:
  Both polygons on map:
    Dashed = Phase A (old)
    Solid gold = Phase B (new)
  Stats card + buffer slider
  [✅ UPGRADE TO PHASE B] button
  On upgrade: set use_driven_polygon = true in Supabase
              All drivers get precise detection instantly
```

---

# 🤖 BUILD PROMPTS

---

## ════════════════════════════════════════
## PROMPT 1 OF 4 — Core Libraries
## ════════════════════════════════════════

```
Build three core utility libraries for LvTaxi React Native app.
Pure JavaScript files with no React dependencies.

INSTALL: npm install @turf/turf kalmanjs

────────────────────────────────────────
FILE 1: /src/lib/polygonEngine.js
────────────────────────────────────────

1. GPSKalmanFilter class
   constructor(): init latFilter + lngFilter (R:0.01, Q:3)
   filter(rawLat, rawLng): return { lat, lng } smoothed
   reset(): reinitialize both filters

2. buildPolygonFromTrack(smoothedPoints, bufferMeters=4.0)
   Build GeoJSON LineString from smoothed points [lng,lat]
   Apply turf.buffer(line, bufferMeters, {units:'meters', steps:8})
   Return GeoJSON polygon with properties

3. rebuildWithBuffer(smoothedPoints, newBuffer)
   Calls buildPolygonFromTrack with new buffer

4. isDriverInZone(driverLat, driverLng, zone)
   If zone.use_driven_polygon: check driven_polygon
   Else: check drawn_polygon
   Use turf.booleanPointInPolygon
   Return boolean

5. detectCurrentZone(driverLat, driverLng, allZones)
   Pre-filter zones within 500m using Haversine
   Run isDriverInZone on nearby zones only
   Return matching zone or null

6. validateTrack(rawPoints, smoothedPoints)
   Check: min 10 points, avg accuracy < 5m,
          track length > 8m, no GPS jumps > 10m
   Return { valid, warnings[], stats{} }

7. getDistanceMeters(lat1, lng1, lat2, lng2)
   Haversine formula, return float meters

8. calculateTrackLength(points)
   Sum turf.distance between consecutive points

────────────────────────────────────────
FILE 2: /src/lib/locationEngine.js
────────────────────────────────────────

Uses expo-location and expo-task-manager.

1. GPSKalmanFilter instance (module-level)

2. startTracking(mode)
   mode: 'high' | 'low' | 'idle'
   high: timeInterval:1000, distanceInterval:0.5
   low:  timeInterval:30000, distanceInterval:5
   idle: timeInterval:5000, distanceInterval:2
   All use Accuracy.BestForNavigation
   Apply Kalman filter to every update
   Dispatch smoothed position to Redux

3. setHighFrequency() → restarts with high mode
4. setLowFrequency()  → restarts with low mode
5. setIdleFrequency() → restarts with idle mode

6. Background task: LVTAXI_LOCATION_TASK
   Runs even when app is closed
   Apply Kalman filter
   Call detectCurrentZone
   Handle zone enter/exit events
   Update driver position in Supabase every 5 seconds

────────────────────────────────────────
FILE 3: /src/lib/behavioralClassifier.js
────────────────────────────────────────

1. extractFeatures(gpsPoints)
   Calculate from GPS array:
   dwellSeconds, avgSpeedInZone, maxSpeedInZone,
   timeStationary, positionVariance, entrySpeed,
   exitSpeed, entryAcceleration, exitAcceleration,
   headingChange, movedForwardGradually,
   isStopStartPattern, exitedSameSide,
   stoppedAtEntrance
   Return features object

2. classifyVisit(features, driverHistory)
   Implement full scoring rules as defined in plan
   Return { classification, score }
   Classifications: STAGING / DROP_OFF / PASSING / UNKNOWN

3. processZoneExit(visitId, driverId, zoneId, gpsPoints)
   Stop trajectory recording
   Extract features
   Load driver history from Supabase
   Classify visit
   Update zone_visit record
   If STAGING: decrement count + record load event
   If DROP_OFF/PASSING: decrement count only
   If UNKNOWN: send confirmation notification
   Update driver_zone_history
```

---

## ════════════════════════════════════════
## PROMPT 2 OF 4 — Database + Import Script
## ════════════════════════════════════════

```
Build the Supabase database setup and GeoJSON import
system for LvTaxi.

────────────────────────────────────────
FILE 1: /scripts/setupDatabase.sql
────────────────────────────────────────
Full SQL to create all tables:
  staging_zones, zone_stats, load_events,
  zone_visits, trajectories,
  driver_zone_history, zone_tracks

Create all stored procedures:
  increment_zone_count(p_zone_id uuid)
  decrement_zone_count(p_zone_id uuid)
  record_load_event(p_zone_id uuid)
    (recalculates flow_rate and wait_time_minutes)

Enable Supabase Realtime on zone_stats table

────────────────────────────────────────
FILE 2: /scripts/importGeoJSON.js
────────────────────────────────────────
CLI script: node importGeoJSON.js <filename.geojson>

Reads GeoJSON FeatureCollection from file
For each Polygon feature:
  Extract name from properties.Name or properties.name
  Check if zone already exists (skip if duplicate)
  Insert to staging_zones:
    name, drawn_polygon, drawn_coordinates,
    use_driven_polygon: false,
    active: true, visible_to_drivers: true,
    is_coming_soon: false
  Insert to zone_stats:
    zone_id, cars_staged:0, flow_rate_per_hour:0,
    wait_time_minutes: null

Log: "✅ Imported: [name]" per zone
Log: "✅ Done: X zones imported, Y skipped"

────────────────────────────────────────
FILE 3: /src/lib/zoneCache.js
────────────────────────────────────────
Load and cache all zones from Supabase.
Works offline via AsyncStorage fallback.

loadZones():
  Fetch all zones WHERE active = true
  Include: id, name, drawn_polygon, driven_polygon,
           use_driven_polygon, is_coming_soon,
           visible_to_drivers
  Cache in memory + AsyncStorage 'lvtaxi_zones_v2'
  Save timestamp 'lvtaxi_zones_updated'

getZones():
  Memory cache first → AsyncStorage → loadZones()

getActiveZones():
  Filter getZones() for visible_to_drivers = true
  AND is_coming_soon = false

getComingSoonZones():
  Filter for is_coming_soon = true

refreshIfStale():
  If > 24 hours since last update → loadZones()

subscribeToZoneUpdates():
  Supabase Realtime on staging_zones
  Any change → refresh cache → update Redux
  This means Phase B upgrades appear instantly
  to all drivers without app update
```

---

## ════════════════════════════════════════
## PROMPT 3 OF 4 — Main Screen UI
## ════════════════════════════════════════

```
Build the complete HomeScreen UI for LvTaxi.
This is the main screen drivers see every time they open the app.

FILE: /src/screens/HomeScreen.jsx

════════════════════════════════════════
HEADER
════════════════════════════════════════
Left:  "🚕 LvTaxi" app name
Right: DriverToggle component (from File 1 Auth)

════════════════════════════════════════
SORT BAR
════════════════════════════════════════
Three pill buttons in a row:
  [⏱️ Wait] [⚡ Flow] [📍 Near]

Default: Wait is always selected on app open
Active pill: gold background #F5C518, dark text
Inactive pill: dark background, grey text

On sort change:
  Update Redux zonesSlice.activeSort
  Re-sort the zone list
  Re-calculate top zones for notification monitoring

════════════════════════════════════════
ZONE LIST
════════════════════════════════════════
FlatList of ZoneListItem components.

SORT LOGIC:
  'wait': sort by wait_time_minutes ascending
          NULL wait times always last
          Coming soon zones always last
  'flow': sort by flow_rate_per_hour descending
  'near': sort by distance from driver GPS ascending

HEADER ROW (not scrollable, sticky):
  CARS | FLOW | WAIT | LOCATION
  Small grey text, matches column positions

ZoneListItem for ACTIVE zones:
  Left color bar: 🟢<10min 🟡10-20min 🔴>20min ⚫no data
  Cars: large bold number
  Flow: "[X]/hr" smaller text
  Wait: "[X] mins" or "?" if null
  Location: zone name, truncated if too long

  If driver is inside this zone:
    Pulsing gold border around entire row
    Replace wait with: "📍 You are here"

ZoneListItem for COMING SOON zones:
  Grey background, all columns empty
  Location column: "[Zone Name] — Coming Soon"
  Smaller font, italic
  Always at very bottom of list

Pull to refresh:
  Manually refresh zone stats from Supabase
  Show loading spinner in list header

════════════════════════════════════════
REAL-TIME UPDATES
════════════════════════════════════════
In useZones hook:

On mount:
  Load all zones from zoneCache
  Load zone stats from Supabase
  Combine into unified list
  Subscribe to Supabase Realtime on zone_stats

On zone_stats UPDATE event:
  Update that zone's stats in Redux
  Re-sort list if needed
  Animate the changed row (brief gold flash, 300ms)

On unmount:
  Unsubscribe Realtime channel

════════════════════════════════════════
REDUX — ZONES SLICE
════════════════════════════════════════
FILE: /src/store/zonesSlice.js

State:
  allZones: []         ← all zones from Supabase
  zoneStats: {}        ← { zone_id: { cars, flow, wait } }
  activeSort: 'wait'   ← always 'wait' on app open
  driverZoneId: null   ← zone driver is currently in

Selectors:
  selectSortedZones: combines allZones + zoneStats
                     applies sort, puts coming soon last

Actions:
  setZones, updateZoneStat, setActiveSort, setDriverZone

════════════════════════════════════════
STYLING
════════════════════════════════════════
Background: #0A0A0F (near black)
Header: #0F0F1A
Zone list item: #1A1A2E
Active zone highlight: gold border #F5C518 pulsing
Coming soon: #0F0F1A with grey text
Green wait: #22C55E background tint
Yellow wait: #EAB308 background tint
Red wait: #EF4444 background tint
Font: system font, clean and readable
Row height: 56px minimum (touch friendly)
```

---

## ════════════════════════════════════════
## PROMPT 4 OF 4 — Admin Dashboard (Web)
## ════════════════════════════════════════

```
Build the LvTaxi web admin dashboard.
Deployed at admin.lvtaxi.com on Vercel.

TECH: React 18 + Vite, Mapbox GL JS,
      @turf/turf, @supabase/supabase-js, Tailwind CSS

════════════════════════════════════════
LAYOUT (full screen, no scroll)
════════════════════════════════════════
┌────────────────┬────────────────────────┐
│  SIDEBAR 280px │   MAPBOX SATELLITE MAP │
│                │   (fills rest)         │
│  🚕 LvTaxi    │                        │
│  Admin Panel   │   All zone polygons    │
│  ───────────   │   shown with colors    │
│                │                        │
│  Zone list     │                        │
│  (scrollable)  ├────────────────────────┤
│                │   DETAILS PANEL        │
│  ───────────   │   (when zone selected) │
│  [Upload JSON] │   Height: 280px        │
│  [Export]      │                        │
└────────────────┴────────────────────────┘

════════════════════════════════════════
AUTH
════════════════════════════════════════
Supabase email + password login
Check role = 'admin' after login
Redirect non-admin to error page

════════════════════════════════════════
SIDEBAR
════════════════════════════════════════
Stats header:
  Active: [N]  Coming Soon: [N]  Total: [N]

Zone list cards showing:
  Zone name
  Phase badge: 🟡 Phase A | 🟢 Phase B
  Status: ✅ Active | ⏸ Inactive | 🔜 Coming Soon
  Click → select zone on map + open details panel

Buttons:
  [+ Draw New Zone]   → enter DRAW mode on map
  [📂 Upload GeoJSON] → file upload modal
  [⬇️ Export All]     → download all as .geojson

Realtime subscription on staging_zones:
  Refresh list on any change

════════════════════════════════════════
MAP
════════════════════════════════════════
Mapbox satellite-streets style
Center: Las Vegas Strip [-115.1728, 36.1147], zoom 13

Zone polygon colors:
  Active Phase A:     gold fill 0.25, solid border
  Active Phase B:     gold fill 0.35, solid border + "B" badge
  Coming Soon:        grey fill 0.15, dashed border
  Inactive:           grey fill 0.10, dotted border
  Selected:           brighter fill + thicker border

Map modes: VIEW | DRAW | EDIT

DRAW mode:
  Click to add vertices
  Double-click to close polygon
  Dialog: enter zone name + select buffer size
  Save → insert to Supabase

EDIT mode:
  Drag vertex handles to reshape polygon
  [Save] → update Supabase + log zone_edits
  [Cancel] → revert

════════════════════════════════════════
DETAILS PANEL
════════════════════════════════════════
Zone name (editable inline, auto-save)

Toggles (each saves to Supabase immediately):
  Active:              on/off
  Visible to drivers:  on/off
  Coming Soon:         on/off

Buffer slider (Phase B zones only):
  2m ←──────●──────→ 6m
  On change: rebuild polygon from zone_tracks
  [Apply] → save to Supabase

Live stats (from zone_stats table):
  🚗 Cars staged now: [N]
  ⚡ Flow rate: [N]/hr
  ⏱️ Wait time: [N] mins or ?

Metadata:
  Phase A: polygon point count
  Phase B: track length, GPS accuracy, points

Actions:
  [✏️ Edit Polygon]
  [📋 Copy GeoJSON]
  [🗑️ Delete] (confirm dialog)

════════════════════════════════════════
GEOJSON UPLOAD MODAL
════════════════════════════════════════
Drag & drop area OR click to browse
Accepts: .geojson .json

On file selected:
  Parse GeoJSON FeatureCollection
  Show preview table:
    Zone Name | Coordinates | Status
    Bellagio  | 40 points   | ✅ New
    MGM Grand | 54 points   | ⚠️ Already exists

  [Import X New Zones] button
  On import:
    Insert new zones to Supabase
    Skip existing (by name match)
    Show success summary
    Map and sidebar refresh instantly
```

---

# 📅 FULL BUILD TIMELINE

| Step | File | Est. Time |
|---|---|---|
| 1 | setupDatabase.sql | 1 hour |
| 2 | importGeoJSON.js script | 1 hour |
| 3 | polygonEngine.js | 2 hours |
| 4 | locationEngine.js | 2 hours |
| 5 | behavioralClassifier.js | 2 hours |
| 6 | zoneCache.js | 1 hour |
| 7 | zonesSlice.js (Redux) | 1 hour |
| 8 | HomeScreen.jsx | 3 hours |
| 9 | Admin dashboard (web) | 6 hours |
| 10 | Zone Creator screen | 4 hours |
| 11 | Push notifications | 2 hours |
| **Total** | | **~25 hours** |

---

# 🚀 LAUNCH CHECKLIST

```
Before launch:
☐ Auth system built and tested (File 1)
☐ Database tables created (setupDatabase.sql)
☐ 24 zones imported (importGeoJSON.js)
☐ 13 coming soon zones added to Supabase manually
☐ Admin account role set to 'admin' in Supabase
☐ Admin dashboard deployed to Vercel
☐ App submitted to App Store + Google Play

After launch:
☐ Monitor daily active users
☐ Add 13 missing zones via admin dashboard
☐ Start Phase B recording at 1-2 months
☐ Introduce subscription at 500 daily users
```

---

# 🔗 HOW FILES 1 AND 2 CONNECT

```
File 1 (Auth)                    File 2 (App)
─────────────────                ─────────────────────────
authSlice.driver       →         Zone counting uses driver.id
driver.toggle_active   →         locationEngine frequency
driver.role === admin  →         Zone Creator + Admin access
Session check          →         All screens protected
DriverToggle component →         Shown in HomeScreen header
```

---

*LvTaxi — File 2 of 2. Authentication is in File 1.*
