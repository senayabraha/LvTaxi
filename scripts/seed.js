#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { STAGING_ZONES } = require('../src/lib/constants');

const url = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

function mockStats() {
  const cars = Math.floor(Math.random() * 30) + 5;
  const flow = Math.floor(Math.random() * 80) + 40;
  const wait = (cars / flow) * 60;
  return {
    cars_staged: cars,
    flow_rate_per_hour: flow,
    wait_time_minutes: Number(wait.toFixed(1)),
    last_updated: new Date().toISOString(),
  };
}

async function main() {
  console.log(`Seeding ${STAGING_ZONES.length} zones into ${url}…`);

  const zoneRows = STAGING_ZONES.map((z) => ({
    id: z.id,
    name: z.name,
    lat: z.lat,
    lng: z.lng,
    radius_meters: z.radius,
    active: true,
  }));

  const { error: zErr } = await supabase
    .from('staging_zones')
    .upsert(zoneRows, { onConflict: 'id' });
  if (zErr) {
    console.error('staging_zones upsert failed:', zErr.message);
    process.exit(1);
  }
  console.log(`  ✓ Upserted ${zoneRows.length} staging_zones`);

  const statsRows = STAGING_ZONES.map((z) => ({ zone_id: z.id, ...mockStats() }));
  const { error: sErr } = await supabase
    .from('zone_stats')
    .upsert(statsRows, { onConflict: 'zone_id' });
  if (sErr) {
    console.error('zone_stats upsert failed:', sErr.message);
    process.exit(1);
  }
  console.log(`  ✓ Upserted ${statsRows.length} zone_stats (mock data)`);

  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
