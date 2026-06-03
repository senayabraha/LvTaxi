// Supabase Edge Function: send-push
// POST /functions/v1/send-push
// Body: { title, message | body, type?, driver_id?, zone_id? }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type SendPushBody = {
  title?: string;
  message?: string;
  body?: string;
  type?: string;
  driver_id?: string;
  zone_id?: string | null;
  send_to_all?: boolean;
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

    const payload = (await req.json()) as SendPushBody;
    const title = payload.title?.trim();
    const message = (payload.message ?? payload.body)?.trim();
    const type = payload.type?.trim() || 'admin_announcement';
    const zoneId = payload.zone_id ?? null;

    if (!title || !message) {
      return json({ error: 'title and message are required' }, 400);
    }

    const supabase = createClient(supabaseUrl, secretKey);
    const driversQuery = supabase.from('drivers').select('id, push_token');
    const { data: drivers, error: driversError } = payload.driver_id
      ? await driversQuery.eq('id', payload.driver_id)
      : await driversQuery.not('push_token', 'is', null);

    if (driversError) {
      console.error('[send-push] driver lookup failed', driversError);
      return json({ error: 'failed to load drivers' }, 500);
    }

    const validDrivers = ((drivers ?? []) as DriverRow[]).filter((driver) =>
      isExpoPushToken(driver.push_token)
    );

    if (validDrivers.length === 0) {
      return json({ ok: true, sent: 0, message: 'No valid Expo push tokens found' });
    }

    const expoMessages = validDrivers.map((driver) => ({
      to: driver.push_token,
      sound: 'default',
      title,
      body: message,
      data: {
        type,
        driver_id: driver.id,
        zone_id: zoneId,
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
      expo: expoData,
      logged: !logError,
      log_error: logError?.message ?? null,
    });
  } catch (err) {
    console.error('[send-push] unexpected error', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
