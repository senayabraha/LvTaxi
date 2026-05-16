import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { setSort } from '../store/zonesSlice';
import { SORT_OPTIONS } from '../lib/constants';

const TABS = [
  { value: SORT_OPTIONS.NEAREST, label: 'Nearest', icon: '📍' },
  { value: SORT_OPTIONS.FLOW, label: 'Flow', icon: '⚡' },
  { value: SORT_OPTIONS.WAIT, label: 'Wait', icon: '⏱️' },
];

export default function SortBar() {
  const dispatch = useDispatch();
  const activeSort = useSelector((s) => s.zones.activeSort);

  return (
    <View className="flex-row mx-4 mb-2 bg-panel rounded-lg border border-border overflow-hidden">
      {TABS.map((tab) => {
        const active = activeSort === tab.value;
        return (
          <Pressable
            key={tab.value}
            onPress={() => dispatch(setSort(tab.value))}
            className={`flex-1 py-3 items-center ${active ? 'bg-panel2' : ''}`}
          >
            <Text className={active ? 'text-accent font-semibold' : 'text-muted'}>
              {tab.icon} {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
