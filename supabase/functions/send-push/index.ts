// Supabase Edge Function: send-push
// POST /functions/v1/send-push
// Body: { title, message | body, type?, audience?, driver_id?, zone_id?, taxi_company? }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Audience = 'all' | 'active' | 'company' | 'zone' | 'driver';

type SendPushBody = {
  title?: string;
  message?: string;
  body?: string;
  type?: string;
  audience?: Audience;
  driver_id?: string;
  zone_id?: string | null;
  taxi_company?: string;
};

type DriverRow = {
  id: string;
  push_token: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

function isExpoPushToken(token: string | null | undefined) {
  return (
    typeof token === 'string' &&
    (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['))
  );
}

function getBearerToken(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const secretKey =
      Deno.env.get('SUPABASE_SECRET_KEY') ??
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SERVICE_ROLE_KEY') ??
      '';

    if (!supabaseUrl || !secretKey) {
      return json({ error: 'missing Supabase URL or service role secret' }, 500);
    }

    const supabase = createClient(supabaseUrl, secretKey);
    const token = getBearerToken(req);

    if (!token) {
      return json({ error: 'missing authorization token' }, 401);
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user?.id) {
      return json({ error: 'invalid authorization token' }, 401);
    }

    const { data: adminDriver, error: adminError } = await supabase
      .from('drivers')
      .select('id, role')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (adminError) {
      console.error('[send-push] admin lookup failed', adminError);
      return json({ error: 'failed to verify admin role' }, 500);
    }

    if (adminDriver?.role !== 'admin') {
      return json({ error: 'admin role required' }, 403);
    }

    const payload = (await req.json()) as SendPushBody;
    const title = payload.title?.trim();
    const message = (payload.message ?? payload.body)?.trim();
    const type = payload.type?.trim() || 'admin_announcement';
    const audience = payload.audience ?? (payload.driver_id ? 'driver' : 'all');
    const zoneId = payload.zone_id ?? null;
    const taxiCompany = payload.taxi_company?.trim();

    if (!title || !message) {
      return json({ error: 'title and message are required' }, 400);
    }

    if (audience === 'driver' && !payload.driver_id) {
      return json({ error: 'driver_id is required for driver audience' }, 400);
    }
    if (audience === 'company' && !taxiCompany) {
      return json({ error: 'taxi_company is required for company audience' }, 400);
    }
    if (audience === 'zone' && !zoneId) {
      return json({ error: 'zone_id is required for zone audience' }, 400);
    }

    let driversQuery = supabase
      .from('drivers')
      .select('id, push_token')
      .not('push_token', 'is', null);

    if (audience === 'driver') {
      driversQuery = driversQuery.eq('id', payload.driver_id);
    } else if (audience === 'active') {
      driversQuery = driversQuery.in('status', ['active', 'staged', 'passive_near']);
    } else if (audience === 'company') {
      driversQuery = driversQuery.eq('taxi_company', taxiCompany);
    } else if (audience === 'zone') {
      driversQuery = driversQuery.eq('current_zone_id', zoneId);
    }

    const { data: drivers, error: driversError } = await driversQuery;

    if (driversError) {
      console.error('[send-push] driver lookup failed', driversError);
      return json({ error: 'failed to load drivers' }, 500);
    }

    const validDrivers = ((drivers ?? []) as DriverRow[]).filter((driver) =>
      isExpoPushToken(driver.push_token)
    );

    if (validDrivers.length === 0) {
      return json({
        ok: true,
        sent: 0,
        logged: true,
        audience,
        message: 'No valid Expo push tokens found',
      });
    }

    const expoMessages = validDrivers.map((driver) => ({
      to: driver.push_token,
      sound: 'default',
      title,
      body: message,
      data: {
        type,
        audience,
        driver_id: driver.id,
        zone_id: zoneId,
        taxi_company: taxiCompany ?? null,
      },
    }));

    const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(expoMessages),
    });

    const expoData = await expoRes.json();

    const notificationRows = validDrivers.map((driver) => ({
      driver_id: driver.id,
      zone_id: zoneId,
      type,
      message,
    }));

    const { error: logError } = await supabase.from('notifications').insert(notificationRows);

    if (logError) {
      console.error('[send-push] notification log failed', logError);
    }

    return json({
      ok: expoRes.ok,
      sent: validDrivers.length,
      audience,
      expo: expoData,
      logged: !logError,
      log_error: logError?.message ?? null,
    });
  } catch (err) {
    console.error('[send-push] unexpected error', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
