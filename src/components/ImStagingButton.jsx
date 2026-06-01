import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, Alert, Modal, FlatList } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { setStatus, zoneEntered } from '../store/driversSlice';
import { DRIVER_STATUS } from '../lib/constants';
import { supabase } from '../lib/supabase';
import { getDistanceMeters } from '../lib/locationEngine';
import { maybeSendPresenceHeartbeat } from '../lib/presenceHeartbeat';

const NEAR_METERS = 200;

export default function ImStagingButton() {
  const dispatch = useDispatch();
  const status = useSelector((s) => s.drivers.status);
  const driverId = useSelector((s) => s.auth.session?.user?.id);
  const currentLat = useSelector((s) => s.drivers.currentLat);
  const currentLng = useSelector((s) => s.drivers.currentLng);

  const [busy, setBusy] = useState(false);
  const [confirmZone, setConfirmZone] = useState(null);
  const [pickerZones, setPickerZones] = useState(null);

  const disabled = status === DRIVER_STATUS.OFF_DUTY || busy;

  const stageAt = useCallback(
    async (zone) => {
      if (!zone) return;
      setBusy(true);
      try {
        dispatch(setStatus(DRIVER_STATUS.STAGED));
        dispatch(zoneEntered(zone.id));
        // Force an immediate presence write so the live-count RPC picks this
        // driver up right away (no legacy counter — counts come from presence).
        if (driverId) {
          await maybeSendPresenceHeartbeat({
            driverId,
            zoneId: zone.id,
            classification: 'STAGING',
            lat: currentLat,
            lng: currentLng,
            force: true,
          });
        }
        if (driverId) {
          const nowIso = new Date().toISOString();
          const { error } = await supabase
            .from('drivers')
            .update({ status: DRIVER_STATUS.STAGED, last_seen: nowIso })
            .eq('id', driverId);
          if (error) console.warn('[ImStagingButton] update driver failed', error.message);
        }
      } finally {
        setBusy(false);
        setConfirmZone(null);
        setPickerZones(null);
      }
    },
    [dispatch, driverId]
  );

  const onPress = useCallback(async () => {
    if (disabled) return;
    if (currentLat == null || currentLng == null) {
      Alert.alert('No GPS yet', 'Waiting for a location fix.');
      return;
    }

    setBusy(true);
    const { data, error } = await supabase
      .from('staging_zones')
      .select('id, name, lat, lng')
      .eq('active', true)
      .eq('is_coming_soon', false);
    setBusy(false);

    if (error) {
      Alert.alert('Could not load zones', error.message);
      return;
    }

    const withDistance = (data ?? [])
      .filter((z) => z.lat != null && z.lng != null)
      .map((z) => ({
        ...z,
        distance: getDistanceMeters(currentLat, currentLng, z.lat, z.lng),
      }))
      .filter((z) => z.distance <= NEAR_METERS)
      .sort((a, b) => a.distance - b.distance);

    if (withDistance.length === 0) {
      Alert.alert('No staging zone nearby', 'Drive closer to a staging zone and try again.');
      return;
    }

    setConfirmZone(withDistance[0]);
    setPickerZones(withDistance);
  }, [disabled, currentLat, currentLng]);

  return (
    <>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={{
          position: 'absolute',
          bottom: 80,
          right: 20,
          backgroundColor: '#F5C518',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderRadius: 24,
          opacity: disabled ? 0.4 : 1,
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 3 },
          elevation: 6,
        }}
      >
        <Text style={{ color: '#0B0F1A', fontWeight: '700' }}>
          🟡 I’m Staging
        </Text>
      </Pressable>

      {/* Confirm closest zone */}
      <Modal
        visible={!!confirmZone && !!pickerZones}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setConfirmZone(null);
          setPickerZones(null);
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View className="bg-panel border border-border rounded-xl p-5">
            <Text className="text-text text-lg font-semibold mb-2">
              Staging at {confirmZone?.name}?
            </Text>
            <Text className="text-muted text-sm mb-4">
              We’ll mark you as staged here and start the wait timer.
            </Text>

            <View className="flex-row justify-end gap-2">
              <Pressable
                onPress={() => {
                  setConfirmZone(null);
                  setPickerZones(null);
                }}
                className="px-4 py-2 rounded bg-panel2 border border-border"
              >
                <Text className="text-muted">Cancel</Text>
              </Pressable>
              {pickerZones && pickerZones.length > 1 ? (
                <Pressable
                  onPress={() => setConfirmZone(null)}
                  className="px-4 py-2 rounded bg-panel2 border border-border"
                >
                  <Text className="text-text">Wrong zone</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => stageAt(confirmZone)}
                className="px-4 py-2 rounded bg-accent"
                disabled={busy}
              >
                <Text className="text-bg font-semibold">Confirm</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Picker — wrong zone, show all nearby */}
      <Modal
        visible={!!pickerZones && !confirmZone}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerZones(null)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View className="bg-panel border border-border rounded-xl p-5">
            <Text className="text-text text-lg font-semibold mb-3">
              Pick a staging zone
            </Text>
            <FlatList
              data={pickerZones ?? []}
              keyExtractor={(z) => z.id}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => stageAt(item)}
                  className="py-3 border-b border-border"
                >
                  <Text className="text-text">{item.name}</Text>
                  <Text className="text-muted text-xs">
                    {Math.round(item.distance)} m away
                  </Text>
                </Pressable>
              )}
            />
            <View className="flex-row justify-end mt-3">
              <Pressable
                onPress={() => setPickerZones(null)}
                className="px-4 py-2 rounded bg-panel2 border border-border"
              >
                <Text className="text-muted">Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
