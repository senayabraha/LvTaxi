# 🚕 LvTaxi — File 1: Authentication System
## Plan & Build Prompts

---

# 📋 AUTH OVERVIEW

| | |
|---|---|
| **Method** | Phone number + SMS OTP (primary) |
| **Backup** | Email + password |
| **Verification** | None — anyone can sign up |
| **Backend** | Supabase Auth |
| **Driver tracking** | Yes — individual accounts for behavioral scoring |
| **Admin account** | Single admin account (you) |

---

# 🔐 AUTH FLOW

```
USER OPENS APP
      ↓
Check Supabase session
      ↓
Session exists? ──YES──→ Go to Main Screen
      ↓ NO
Show Auth Screen
      ↓
┌─────────────────────────┐
│  Choose sign up method: │
│  📱 Phone Number        │
│  📧 Email               │
└─────────────────────────┘
      ↓
PHONE FLOW:              EMAIL FLOW:
Enter phone number       Enter email + password
      ↓                        ↓
Receive SMS OTP          Supabase creates account
      ↓                        ↓
Enter 6-digit code       Go to Main Screen ✅
      ↓
Verified ✅
      ↓
First time? → Enter name screen
Returning?  → Go to Main Screen ✅
```

---

# 🗄️ SUPABASE SCHEMA — AUTH TABLES

```sql
-- Driver profiles (created after first auth)
CREATE TABLE drivers (
  id                uuid PRIMARY KEY REFERENCES auth.users(id),
  display_name      text,
  phone             text,
  email             text,
  role              text DEFAULT 'driver',
  -- role options: 'driver' | 'admin'

  -- Status
  toggle_active     boolean DEFAULT false,
  -- true  = green (actively driving)
  -- false = grey (not driving)

  -- Location (updated every 5 seconds when active)
  current_lat       float,
  current_lng       float,
  last_seen         timestamp,

  -- Zone tracking
  current_zone_id   uuid REFERENCES staging_zones(id),
  zone_entry_time   timestamp,

  -- Subscription
  subscription_tier text DEFAULT 'free',
  -- 'free' | 'pro'

  -- Audit
  created_at        timestamp DEFAULT now(),
  updated_at        timestamp DEFAULT now()
);

-- Row Level Security
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;

-- Drivers can only read/update their own record
CREATE POLICY "driver_own_record" ON drivers
  FOR ALL USING (auth.uid() = id);

-- Admin can read all drivers
CREATE POLICY "admin_read_all" ON drivers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM drivers 
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
```

---

# 📱 SCREENS

## Screen 1 — Splash Screen
```
Shows on every app launch.
Checks Supabase session silently.

If session valid    → navigate to MainScreen
If session expired  → navigate to AuthScreen
If first launch     → navigate to AuthScreen

Show:
  🚕 LvTaxi logo (centered)
  Gold on dark background
  Loading indicator (spinner)
  Max 2 seconds then navigate
```

## Screen 2 — Auth Screen
```
Two tab options at top:
  [ 📱 Phone ]  [ 📧 Email ]

PHONE TAB:
  Label: "Phone Number"
  Input: +1 (702) ___ ____
  Country code picker (default: +1 US)
  Button: [ Send Code ]
  
  On Send Code:
    supabase.auth.signInWithOtp({ phone })
    Show OTP input screen

  OTP SCREEN:
    "Enter the 6-digit code sent to [phone]"
    6 individual digit input boxes
    Auto-submit when all 6 entered
    Resend code timer (60 seconds)
    
    On correct OTP:
      supabase.auth.verifyOtp({ phone, token, type: 'sms' })
      Check if driver profile exists in drivers table
      If new user → navigate to NameScreen
      If existing → navigate to MainScreen

EMAIL TAB:
  Label: "Email"
  Input: email address
  Label: "Password"
  Input: password (hidden, toggle show/hide)
  Button: [ Sign In / Sign Up ]
  
  Auto-detect: if email exists → sign in
               if new email   → sign up
  
  On success:
    Same flow as phone — check drivers table
    New user → NameScreen
    Existing → MainScreen

STYLING:
  Dark background #0A0A0F
  Gold accent #F5C518
  Input fields: dark card background
  Buttons: gold background, dark text
  Tab selector: gold underline on active tab
```

## Screen 3 — Name Screen (First Time Only)
```
Shows only on first sign up.

"What should we call you?"
Subtitle: "Your name is only visible to you"

Large text input: [Your first name_____]
Skip button (top right): "Skip"
Continue button: [ Let's Go → ]

On Continue or Skip:
  Create driver record in Supabase drivers table:
  {
    id: auth.user.id,
    display_name: enteredName || 'Driver',
    phone: auth.user.phone || null,
    email: auth.user.email || null,
    role: 'driver',
    toggle_active: false
  }
  Navigate to MainScreen
```

---

# 🔑 ADMIN ACCOUNT

```
Admin account is a regular driver account
with role = 'admin' set manually in Supabase.

Admin-only features:
  - Zone Creator screen (drive-to-record)
  - Access to admin.lvtaxi.com dashboard

How to set admin role:
  In Supabase dashboard → Table Editor → drivers
  Find your account row
  Set role column to 'admin'
  Done — no code change needed

Admin check in app:
  const isAdmin = driver?.role === 'admin'
  If isAdmin: show admin menu in profile screen
```

---

# 🔄 SESSION MANAGEMENT

```javascript
// Check session on app start
const checkSession = async () => {
  const { data: { session } } = await supabase.auth.getSession()
  
  if (session) {
    // Load driver profile
    const { data: driver } = await supabase
      .from('drivers')
      .select('*')
      .eq('id', session.user.id)
      .single()
    
    // Store in Redux
    dispatch(setDriver(driver))
    dispatch(setSession(session))
    
    return true // has session
  }
  return false // no session
}

// Listen for auth changes
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN')  dispatch(setSession(session))
  if (event === 'SIGNED_OUT') dispatch(clearSession())
  if (event === 'TOKEN_REFRESHED') dispatch(setSession(session))
})

// Sign out
const signOut = async () => {
  await supabase.auth.signOut()
  dispatch(clearDriver())
  navigate('AuthScreen')
}
```

---

# 🗂️ REDUX — AUTH SLICE

```javascript
// /src/store/authSlice.js

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    session: null,
    driver: null,
    isLoading: true,
    isAdmin: false,
  },
  reducers: {
    setSession: (state, action) => {
      state.session = action.payload
      state.isLoading = false
    },
    setDriver: (state, action) => {
      state.driver = action.payload
      state.isAdmin = action.payload?.role === 'admin'
    },
    clearSession: (state) => {
      state.session = null
      state.driver = null
      state.isAdmin = false
    },
    clearDriver: (state) => {
      state.driver = null
      state.isAdmin = false
    },
    updateToggle: (state, action) => {
      if (state.driver) {
        state.driver.toggle_active = action.payload
      }
    }
  }
})
```

---

# 🟢⚫ DRIVER STATUS TOGGLE

```
Simple two-state pill toggle shown on main screen header.

GREEN  🟢 = Actively driving
  - GPS tracking: full speed (every 1 second)
  - Notifications: ON
  - Counted in zones: YES (if in geofence 3+ mins)

GREY   ⚫ = Not driving
  - GPS tracking: reduced (every 30 seconds)
  - Notifications: OFF
  - Counted in zones: YES (if in geofence 3+ mins)

IMPORTANT RULE:
Both green AND grey drivers are counted in zone stats
if they are inside a geofenced area for 3+ minutes.
The toggle only controls GPS frequency and notifications.
It does NOT exclude a driver from zone counting.

SEMI-AUTOMATIC BEHAVIOR:
When GPS detects driver has been stationary for 10+ minutes
inside a staging zone → app suggests:
"🚕 Are you on duty? Turn on driving mode"
[ ✅ Yes, I'm driving ]  [ ❌ Not now ]
Driver taps to confirm. Never changes automatically.
```

```javascript
// Toggle component
const DriverToggle = () => {
  const { driver } = useSelector(state => state.auth)
  const dispatch = useDispatch()
  
  const handleToggle = async (newValue) => {
    // Update locally first (instant UI response)
    dispatch(updateToggle(newValue))
    
    // Sync to Supabase
    await supabase.from('drivers').update({
      toggle_active: newValue,
      updated_at: new Date().toISOString()
    }).eq('id', driver.id)
    
    // Adjust GPS tracking frequency
    if (newValue) {
      locationEngine.setHighFrequency() // every 1 second
    } else {
      locationEngine.setLowFrequency()  // every 30 seconds
    }
  }
  
  return (
    <Pressable onPress={() => handleToggle(!driver.toggle_active)}>
      <Animated.View style={[
        styles.togglePill,
        { backgroundColor: driver.toggle_active ? '#22C55E' : '#4B5563' }
      ]}>
        <Animated.View style={styles.toggleDot} />
        <Text style={styles.toggleLabel}>
          {driver.toggle_active ? '🟢 Driving' : '⚫ Off'}
        </Text>
      </Animated.View>
    </Pressable>
  )
}
```

---

# 🤖 BUILD PROMPT — AUTHENTICATION

```
Build the complete authentication system for LvTaxi,
a React Native Expo app for Las Vegas taxi drivers.

TECH STACK:
- React Native (Expo)
- Supabase JS client (@supabase/supabase-js)
- Redux Toolkit (authSlice)
- React Navigation (Stack navigator)
- NativeWind (Tailwind for React Native)

════════════════════════════════════════════
PART 1 — SUPABASE SETUP
════════════════════════════════════════════

FILE: /src/lib/supabase.js
  Initialize Supabase client with URL and anon key
  Export supabase client

FILE: /scripts/setupAuth.sql
  Create drivers table with all columns listed in schema above
  Enable Row Level Security
  Create policies: driver_own_record, admin_read_all

════════════════════════════════════════════
PART 2 — REDUX AUTH SLICE
════════════════════════════════════════════

FILE: /src/store/authSlice.js
  Implement full authSlice as defined above:
  State: session, driver, isLoading, isAdmin
  Reducers: setSession, setDriver, clearSession,
            clearDriver, updateToggle

FILE: /src/store/index.js
  Configure Redux store with authSlice

════════════════════════════════════════════
PART 3 — SPLASH SCREEN
════════════════════════════════════════════

FILE: /src/screens/SplashScreen.jsx

On mount:
  Call supabase.auth.getSession()
  If session exists:
    Fetch driver profile from drivers table
    Dispatch setSession + setDriver to Redux
    Navigate to MainScreen (replace, no back)
  If no session:
    Navigate to AuthScreen (replace, no back)

Show:
  Full screen dark background #0A0A0F
  Centered "🚕 LvTaxi" text in gold #F5C518
  Subtitle: "Las Vegas Taxi Intelligence"
  Loading spinner below text
  Maximum 2 second delay before navigating

════════════════════════════════════════════
PART 4 — AUTH SCREEN
════════════════════════════════════════════

FILE: /src/screens/AuthScreen.jsx

Build a tabbed screen with Phone and Email options.

PHONE TAB:
  Phone number input with country code picker
  Default country: US (+1)
  Format: (702) XXX-XXXX as user types
  [Send Code] button → calls supabase.auth.signInWithOtp({ phone })
  On success → show OTP input (same screen, slide animation)
  
  OTP INPUT:
    6 individual TextInput boxes in a row
    Auto-focus next box as digits entered
    Auto-submit when 6th digit entered
    Call supabase.auth.verifyOtp({ phone, token, type: 'sms' })
    Resend code button with 60 second countdown timer
    On success → checkOrCreateDriver()

EMAIL TAB:
  Email TextInput
  Password TextInput (with show/hide toggle)
  [Continue] button
  Try signInWithPassword first
  If error "Invalid credentials" → signUp instead
  On success → checkOrCreateDriver()

checkOrCreateDriver():
  Query drivers table for auth.user.id
  If exists → dispatch setDriver → navigate MainScreen
  If not    → navigate NameScreen

ERROR HANDLING:
  Invalid phone: "Please enter a valid phone number"
  Wrong OTP: "Incorrect code. Please try again."
  Network error: "No connection. Please check your internet."
  All errors shown as red text below the relevant input

STYLING:
  Background: #0A0A0F
  Card panels: #1A1A2E
  Gold accent: #F5C518 for buttons and active tab
  Input borders: #2A2A3E, gold when focused
  All inputs 52px height minimum

════════════════════════════════════════════
PART 5 — NAME SCREEN
════════════════════════════════════════════

FILE: /src/screens/NameScreen.jsx

Single large TextInput: "What should we call you?"
Subtitle: "Your name is only visible to you"
[Let's Go →] button (gold, full width, 56px height)
[Skip] text button top right

On Let's Go or Skip:
  Insert to Supabase drivers table:
  {
    id: supabase.auth.getUser().id,
    display_name: name || 'Driver',
    phone: user.phone || null,
    email: user.email || null,
    role: 'driver',
    toggle_active: false,
    created_at: now()
  }
  Dispatch setDriver to Redux
  Navigate to MainScreen (replace)

════════════════════════════════════════════
PART 6 — SESSION LISTENER
════════════════════════════════════════════

FILE: /src/lib/sessionManager.js

setupSessionListener():
  supabase.auth.onAuthStateChange((event, session) => {
    if event === SIGNED_IN:     dispatch setSession + fetch driver
    if event === SIGNED_OUT:    dispatch clearSession, navigate AuthScreen
    if event === TOKEN_REFRESHED: dispatch setSession
  })

signOut():
  await supabase.auth.signOut()
  dispatch clearDriver
  navigate AuthScreen

════════════════════════════════════════════
PART 7 — DRIVER TOGGLE
════════════════════════════════════════════

FILE: /src/components/DriverToggle.jsx

Animated pill toggle component:
  Width: 120px, Height: 40px, border-radius: 20px
  Green (#22C55E) when active, Grey (#4B5563) when inactive
  Smooth color transition animation (300ms)
  Moving dot that slides left/right
  Label: "🟢 Driving" or "⚫ Off"

On press:
  Toggle driver.toggle_active in Redux (instant)
  Update Supabase drivers table
  If turning ON: call locationEngine.setHighFrequency()
  If turning OFF: call locationEngine.setLowFrequency()

Semi-auto suggestion:
  Subscribe to Redux zone state
  If driver inside zone for 10+ mins AND toggle is grey:
    Show bottom sheet: "Are you on duty?"
    [ ✅ Yes, I'm driving ]  [ ❌ Not now ]
    Never auto-change without driver confirmation

════════════════════════════════════════════
PART 8 — NAVIGATION SETUP
════════════════════════════════════════════

FILE: /src/navigation/AppNavigator.jsx

Stack Navigator:
  SplashScreen     (no header)
  AuthScreen       (no header)
  NameScreen       (no header)
  MainScreen       (custom header with toggle)
  ProfileScreen    (back button)
  AdminScreen      (back button, admin only)

Protected route logic:
  MainScreen checks Redux for valid session
  AdminScreen checks Redux for isAdmin === true
  Redirect to AuthScreen if no session
  Redirect to MainScreen if not admin
```

---

# 📅 BUILD ORDER

| Step | File | Est. Time |
|---|---|---|
| 1 | supabase.js + setupAuth.sql | 30 mins |
| 2 | authSlice.js + Redux store | 30 mins |
| 3 | SplashScreen.jsx | 30 mins |
| 4 | AuthScreen.jsx (phone + email) | 2 hours |
| 5 | NameScreen.jsx | 30 mins |
| 6 | sessionManager.js | 30 mins |
| 7 | DriverToggle.jsx | 1 hour |
| 8 | AppNavigator.jsx | 30 mins |
| **Total** | | **~6 hours** |

---

*LvTaxi Auth — Simple signup, zero friction, every Las Vegas driver welcome.*
