import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, Modal, FlatList } from 'react-native';
import { useSelector } from 'react-redux';
import { DRIVER_STATUS } from '../lib/constants';
import { supabase } from '../lib/supabase';
import { getDistanceMeters } from '../lib/locationEngine';
import { maybeSendPresenceHeartbeat } from '../lib/presenceHeartbeat';
import { startRecording } from '../lib/trajectoryRecorder';
import { registerActiveVisit } from '../lib/geofenceEngine';
import { transitionToStaged } from '../lib/driverStatusTransitions';
import { confirmStagingLocation } from '../lib/polygonConfirmation';
import { showToast } from '../lib/toast';

// Coarse pre-filter only — how far from a zone centre we bother SHOWING it as a
// staging candidate. Actual staging requires confirmStagingLocation() (polygon
// containment, or a tight radius for polygon-less zones), never this radius.
const NEAR_METERS = 200;

export default function ImStagingButton() {
  const status = useSelector((s) => s.drivers.status);
  const driverId = useSelector((s) => s.auth.session?.user?.id);
  const currentLat = useSelector((s) => s.drivers.currentLat);
  const currentLng = useSelector((s) => s.drivers.currentLng);
  const rawAccuracy = useSelector((s) => s.drivers.rawAccuracy);

  const [busy, setBusy] = useState(false);
  const [confirmZone, setConfirmZone] = useState(null);
  const [pickerZones, setPickerZones] = useState(null);

  const canStage =
    status === DRIVER_STATUS.ACTIVE || status === DRIVER_STATUS.STAGED;

  const stageAt = useCallback(
    async (zone) => {
      if (!zone) return;
      setBusy(true);
      try {
        // 0. Confirm the driver is actually IN the lane before staging. Manual
        // staging must clear the same bar as the geofence path: inside the
        // zone polygon, or (polygon-less zones) within the zone's tight radius —
        // never a flat 200 m. Outside → do not stage.
        const confirmation = confirmStagingLocation(zone, currentLat, currentLng);
        if (!confirmation.confirmed) {
          showToast(
            `You're not in the ${zone.name} lane yet — drive into the lane to stage`,
            'info'
          );
          return;
        }

        // 1. Route through the single staging transition: it updates Redux + the
        // drivers row AND ensures exactly one open zone_visits row (Issue 4), so
        // the manual button no longer inserts its own (which caused duplicate
        // visits on rapid taps / overlap with the geofence path — CNT-5).
        const result = await transitionToStaged(driverId, zone.id, {
          source: 'ImStagingButton.stageAt',
        });
        const visitId = result.visitId ?? null;

        // 2. Register with the geofence engine so handleExit finds this visit.
        registerActiveVisit(zone.id, visitId);

        // 3. Start trajectory recording so exit classification has GPS data.
        startRecording(visitId, { lat: zone.lat, lng: zone.lng });

        // 4. Force an immediate presence heartbeat so the driver is counted now.
        if (driverId) {
          await maybeSendPresenceHeartbeat({
            driverId,
            zoneId: zone.id,
            classification: 'STAGING',
            lat: currentLat,
            lng: currentLng,
            accuracy: rawAccuracy,
            visitId,
            force: true,
          });
        }

        showToast(`Staged at ${zone.name}`, 'success');
      } finally {
        setBusy(false);
        setConfirmZone(null);
        setPickerZones(null);
      }
    },
    [driverId, currentLat, currentLng, rawAccuracy]
  );

  const onPress = useCallback(async () => {
    if (!canStage) {
      showToast('Go online first to use staging', 'info');
      return;
    }
    if (busy) return;

    if (currentLat == null || currentLng == null) {
      showToast('Waiting for a GPS fix…', 'info');
      return;
    }

    setBusy(true);
    const { data, error } = await supabase
      .from('staging_zones')
      .select(
        'id, name, lat, lng, radius_meters, drawn_polygon, driven_polygon, use_driven_polygon'
      )
      .eq('active', true)
      .eq('is_coming_soon', false);
    setBusy(false);

    if (error) {
      showToast('Could not load zones — try again', 'error');
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
      showToast('No staging zone nearby — drive closer', 'info');
      return;
    }

    setConfirmZone(withDistance[0]);
    setPickerZones(withDistance);
  }, [canStage, busy, currentLat, currentLng]);

  return (
    <>
      <View
        style={{
          position: 'absolute',
          bottom: 80,
          right: 20,
          zIndex: 10,
          elevation: 10,
        }}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={onPress}
          style={{
            backgroundColor: canStage ? '#F5C518' : '#888',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderRadius: 24,
            opacity: busy ? 0.7 : 1,
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 3 },
          }}
        >
          <Text style={{ color: canStage ? '#0B0F1A' : '#ddd', fontWeight: '700' }}>
            🟡 I'm Staging
          </Text>
        </Pressable>
      </View>

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
              We'll mark you as staged here and start the wait timer.
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
