const env = process.env.EXPO_PUBLIC_ENV ?? 'development';
const isProduction = env === 'production';

const name = isProduction ? 'LvTaxi' : 'LvTaxi Staging';
const icon = isProduction ? './assets/icon.png' : './assets/icon-staging.png';
const adaptiveIcon = isProduction
  ? './assets/adaptive-icon.png'
  : './assets/adaptive-icon-staging.png';

module.exports = {
  expo: {
    name,
    slug: 'lvtaxi',
    scheme: 'lvtaxi',
    version: '1.0.0',
    orientation: 'portrait',
    icon,
    userInterfaceStyle: 'dark',
    primaryColor: '#F5C518',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#0B0F1A',
    },
    assetBundlePatterns: ['**/*'],
    plugins: [
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission:
            'LvTaxi uses your location to detect when you enter and leave staging zones, even when the app is in the background.',
          locationWhenInUsePermission:
            'LvTaxi uses your location to show nearby staging zones and your wait position.',
          isAndroidBackgroundLocationEnabled: true,
        },
      ],
      [
        'expo-notifications',
        {
          color: '#F5C518',
        },
      ],
    ],
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.lvtaxi.app',
      buildNumber: '1',
      config: {
        usesNonExemptEncryption: false,
      },
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'LvTaxi uses your location to show nearby staging zones and your wait position.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'LvTaxi tracks your location in the background to detect when you enter and leave staging zones.',
        NSLocationAlwaysUsageDescription:
          'LvTaxi tracks your location in the background to detect when you enter and leave staging zones.',
        UIBackgroundModes: ['location', 'fetch'],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: adaptiveIcon,
        backgroundColor: '#0B0F1A',
      },
      package: 'com.lvtaxi.app',
      versionCode: 1,
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_LOCATION',
        'POST_NOTIFICATIONS',
      ],
    },
    extra: {
      supabaseUrl: '',
      supabasePublishableKey: '',
      privacyPolicyUrl: 'https://lvtaxi.app/privacy',
      termsUrl: 'https://lvtaxi.app/terms',
    },
  },
};
