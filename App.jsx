import './global.css';
import React, { useEffect } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text } from 'react-native';

import { store } from './src/store';
import { setupSessionListener } from './src/lib/sessionManager';
import { startTierManager, stopTierManager } from './src/lib/tierManager';
import { retryPendingTrajectories } from './src/lib/visitProcessor';
import SplashScreen from './src/screens/SplashScreen';
import AuthScreen from './src/screens/AuthScreen';
import NameScreen from './src/screens/NameScreen';
import PasswordResetScreen from './src/screens/PasswordResetScreen';
import LocationPermissionScreen from './src/screens/LocationPermissionScreen';
import HomeScreen from './src/screens/HomeScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import AnalyticsScreen from './src/screens/AnalyticsScreen';
import ErrorBoundary from './src/components/ErrorBoundary';
import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'https://4ff6c3c60cdba5f3445bf3082314671e@o4511432069480448.ingest.us.sentry.io/4511432125841408',
  sendDefaultPii: false,
  enableLogs: false,
  beforeSend(event) {
    if (event.contexts) {
      delete event.contexts.geo;
      delete event.contexts.gps;
      delete event.contexts.location;
    }
    if (event.extra) {
      for (const key of Object.keys(event.extra)) {
        if (/lat|lng|longitude|latitude|coords|geo/i.test(key)) {
          delete event.extra[key];
        }
      }
    }
    return event;
  },
});

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#0B0F1A',
    card: '#0B0F1A',
    border: '#222B45',
    primary: '#F5C518',
    text: '#E6EAF2',
  },
};

const TAB_ICON = {
  Home: '🚕',
  Analytics: '📊',
  Profile: '👤',
};

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: { backgroundColor: '#121826', borderTopColor: '#222B45' },
        tabBarActiveTintColor: '#F5C518',
        tabBarInactiveTintColor: '#8A93A6',
        tabBarIcon: ({ color }) => (
          <Text style={{ color, fontSize: 18 }}>
            {TAB_ICON[route.name] ?? '•'}
          </Text>
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Analytics" component={AnalyticsScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

function LocationPermissionRoute({ navigation }) {
  return <LocationPermissionScreen onGranted={() => navigation.navigate('Auth')} />;
}

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Auth" component={AuthScreen} />
      <Stack.Screen name="Name" component={NameScreen} />
      <Stack.Screen
        name="LocationPermission"
        component={LocationPermissionRoute}
      />
    </Stack.Navigator>
  );
}

function Root() {
  const dispatch = useDispatch();
  const session = useSelector((s) => s.auth.session);
  const isLoading = useSelector((s) => s.auth.isLoading);
  const profile = useSelector((s) => s.drivers.profile);
  const passwordRecovery = useSelector((s) => s.auth.passwordRecovery);

  useEffect(() => {
    const unsub = setupSessionListener(dispatch);
    return unsub;
  }, [dispatch]);

  useEffect(() => {
    if (session && profile) {
      startTierManager().catch((err) =>
        console.warn('[App] startTierManager failed', err)
      );
      // Flush any trajectory saves that were queued offline on a previous run.
      retryPendingTrajectories().catch((err) =>
        console.warn('[App] retryPendingTrajectories failed', err)
      );
    } else {
      stopTierManager().catch((err) =>
        console.warn('[App] stopTierManager failed', err)
      );
    }
  }, [session, profile]);

  if (isLoading) return <SplashScreen />;

  const showMain = !!session && !!profile;

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style="light" />
      {passwordRecovery ? (
        <PasswordResetScreen />
      ) : showMain ? (
        <MainTabs />
      ) : (
        <AuthStack />
      )}
    </NavigationContainer>
  );
}

export default Sentry.wrap(function App() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <Root />
        </ErrorBoundary>
      </SafeAreaProvider>
    </Provider>
  );
});
