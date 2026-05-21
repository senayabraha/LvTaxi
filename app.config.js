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
            'LvTaxi needs background location to detect when you enter or leave airport and casino staging zones so your place in the taxi queue is updated automatically — including when your screen is off or the app is not in the foreground.',
          locationWhenInUsePermission:
            'LvTaxi uses your location to show nearby staging zones, your distance to each zone, and your current position in the queue.',
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
          'LvTaxi uses your location to show nearby airport and casino staging zones, your distance to each zone, and your current position in the queue.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'LvTaxi needs background location to detect when you enter or leave staging zones so your queue position updates automatically — including when your screen is off or the app is not in the foreground.',
        NSLocationAlwaysUsageDescription:
          'LvTaxi needs background location to detect when you enter or leave staging zones so your queue position updates automatically — including when your screen is off or the app is not in the foreground.',
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
      privacyPolicyUrl: 'https://lvtaxi.online/privacy',
      termsUrl: 'https://lvtaxi.online/terms',
      eas: {
        projectId: process.env.EAS_PROJECT_ID ?? '',
      },
    },
  },
};
