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
import SplashScreen from './src/screens/SplashScreen';
import AuthScreen from './src/screens/AuthScreen';
import NameScreen from './src/screens/NameScreen';
import PasswordResetScreen from './src/screens/PasswordResetScreen';
import LocationPermissionScreen from './src/screens/LocationPermissionScreen';
import HomeScreen from './src/screens/HomeScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import AnalyticsScreen from './src/screens/AnalyticsScreen';
import ErrorBoundary from './src/components/ErrorBoundary';

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

export default function App() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <Root />
        </ErrorBoundary>
      </SafeAreaProvider>
    </Provider>
  );
}
