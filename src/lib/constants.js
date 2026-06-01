export const STAGING_ZONES = [
  {
    id: '11111111-1111-1111-1111-000000000001',
    name: 'Harry Reid T1 (pit)',
    lat: 36.0830,
    lng: -115.1487,
    radius: 80,
  },
  {
    id: '11111111-1111-1111-1111-000000000002',
    name: 'Harry Reid T3 (pit)',
    lat: 36.0871,
    lng: -115.1453,
    radius: 80,
  },
  {
    id: '11111111-1111-1111-1111-000000000003',
    name: 'Bellagio',
    lat: 36.1126,
    lng: -115.1767,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000004',
    name: 'Caesars Palace',
    lat: 36.1162,
    lng: -115.1746,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000005',
    name: 'MGM Grand',
    lat: 36.1023,
    lng: -115.1697,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000006',
    name: 'Mandalay Bay',
    lat: 36.0926,
    lng: -115.1759,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000007',
    name: 'Venetian',
    lat: 36.1213,
    lng: -115.1695,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000008',
    name: 'Aria / Vdara',
    lat: 36.1075,
    lng: -115.1764,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-000000000009',
    name: 'Cosmopolitan',
    lat: 36.1101,
    lng: -115.1745,
    radius: 40,
  },
  {
    id: '11111111-1111-1111-1111-00000000000A',
    name: 'Aria Main (East)',
    lat: 36.1071,
    lng: -115.1755,
    radius: 40,
  },
  {
    id: '11111111-1111-1111-1111-00000000000B',
    name: 'Palazzo',
    lat: 36.1224,
    lng: -115.1697,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-00000000000C',
    name: 'Paris',
    lat: 36.1126,
    lng: -115.1709,
    radius: 40,
  },
  {
    id: '11111111-1111-1111-1111-00000000000D',
    name: 'Luxor',
    lat: 36.0955,
    lng: -115.1761,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-00000000000E',
    name: 'Fontainebleau',
    lat: 36.1366,
    lng: -115.1620,
    radius: 50,
  },
  {
    id: '11111111-1111-1111-1111-00000000000F',
    name: 'Resorts World (Conrad)',
    lat: 36.1352,
    lng: -115.1672,
    radius: 50,
  },
];

// ── Presence freshness ────────────────────────────────────────────────────────
// Single source of truth for the staleness window used everywhere:
// SQL views, RPC functions, UI freshness labels, and live counts.
export const PRESENCE_TTL_SECONDS = 90;
export const PRESENCE_TTL_MS = PRESENCE_TTL_SECONDS * 1000;

export const DRIVER_STATUS = {
  ACTIVE: 'active',
  STAGED: 'staged',
  OFF_DUTY: 'off_duty',
};

export const SORT_OPTIONS = {
  NEAREST: 'nearest',
  FLOW: 'flow',
  WAIT: 'wait',
};
