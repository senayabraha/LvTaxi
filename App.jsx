import './global.css';
import React from 'react';
import { Provider } from 'react-redux';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text } from 'react-native';

import { store } from './src/store';
import { useAuth } from './src/hooks/useAuth';
import SplashScreen from './src/screens/SplashScreen';
import HomeScreen from './src/screens/HomeScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import AnalyticsScreen from './src/screens/AnalyticsScreen';
import ErrorBoundary from './src/components/ErrorBoundary';

const Tab = createBottomTabNavigator();

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

function Root() {
  const { loading } = useAuth();

  if (loading) return <SplashScreen />;
  return <MainTabs />;
}

export default function App() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <ErrorBoundary>
            <Root />
          </ErrorBoundary>
        </NavigationContainer>
      </SafeAreaProvider>
    </Provider>
  );
}
