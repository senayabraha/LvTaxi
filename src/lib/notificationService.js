import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';

const CONFIRM_CATEGORY = 'lvtaxi.staging_confirm';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let initialized = false;
let responseSubscription = null;

export async function initNotifications() {
  if (initialized) return;

  const settings = await Notifications.getPermissionsAsync();
  let status = settings.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') {
    console.warn('[notifications] permission not granted');
  }

  await Notifications.setNotificationCategoryAsync(CONFIRM_CATEGORY, [
    {
      identifier: 'YES',
      buttonTitle: '✅ Yes, I was staged',
      options: { opensAppToForeground: false },
    },
    {
      identifier: 'NO',
      buttonTitle: '❌ No, just dropped off',
      options: { opensAppToForeground: false },
    },
  ]);

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('staging-confirm', {
      name: 'Staging confirmations',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  if (responseSubscription) responseSubscription.remove();
  responseSubscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const visitId = response.notification.request.content.data?.visitId;
      const zoneId = response.notification.request.content.data?.zoneId;
      if (!visitId) return;
      const action = response.actionIdentifier;
      if (action === 'YES') {
        handleConfirmationResponse(visitId, 'YES', { zoneId });
      } else if (action === 'NO') {
        handleConfirmationResponse(visitId, 'NO', { zoneId });
      }
    }
  );

  initialized = true;
}

export async function sendStagingConfirmation(driverId, zoneName, visitId, zoneId) {
  await initNotifications();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Quick check',
      body: `Were you queued at ${zoneName}?`,
      data: { visitId, zoneId, driverId },
      categoryIdentifier: CONFIRM_CATEGORY,
    },
    trigger: null,
  });

  await supabase.from('notifications').insert({
    driver_id: driverId,
    zone_id: zoneId ?? null,
    type: 'staging_confirm',
    message: `Were you queued at ${zoneName}?`,
  });
}

export async function handleConfirmationResponse(visitId, response, ctx = {}) {
  const { processAsStaging, processAsDropoff } = await import('./visitProcessor');
  if (response === 'YES') {
    await processAsStaging(visitId, { confirmed: true, zoneId: ctx.zoneId });
  } else if (response === 'NO') {
    await processAsDropoff(visitId, { confirmed: true, zoneId: ctx.zoneId });
  }
}
