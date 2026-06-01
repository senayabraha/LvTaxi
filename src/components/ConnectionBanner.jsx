import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

function formatAgo(ms) {
  if (!ms) return 'just now';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  return `${h}h ago`;
}

export default function ConnectionBanner({ updatedAt, error }) {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected && state.isInternetReachable !== false);
    });
    NetInfo.fetch().then((state) => {
      setOnline(!!state.isConnected && state.isInternetReachable !== false);
    });
    return () => sub();
  }, []);

  if (online && !error) return null;
  const age = updatedAt ? Date.now() - updatedAt : null;
  // Driver-facing wording only: communicate that LIVE ZONE DATA may be delayed.
  // This is intentionally about zone counts/waits, NOT raw GPS upload status —
  // drivers should never see internal trajectory batching details.
  const label = !online ? 'Reconnecting…' : 'Connection error';
  const detail = !online
    ? `Live data may be delayed · Using cached zone data (${formatAgo(age)})`
    : `Live data may be delayed · Last updated ${formatAgo(age)}`;
  return (
    <View
      style={{ backgroundColor: !online ? '#EAB308' : '#EF4444' }}
      className="px-4 py-2"
    >
      <Text className="text-bg text-xs font-semibold">
        {label} · {detail}
      </Text>
    </View>
  );
}
