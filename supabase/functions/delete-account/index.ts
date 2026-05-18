// Supabase Edge Function: delete-account
// POST /functions/v1/delete-account
// Auth: requires the caller's user JWT (anon-key Authorization header).
// Response: { ok: true } on success.
//
// Soft-deletes the driver row (anonymizes identifiable fields, retains
// aggregate visit history). The auth.users row is intentionally retained
// so that the email cannot be re-registered and FK references from
// zone_visits remain valid. The client is responsible for calling
// signOut() after this returns, which invalidates the local session.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SERVICE_ROLE_KEY') ??
      '';

    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'missing bearer token' }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: 'invalid session' }, 401);
    }
    const userId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey);

    const { error: softErr } = await admin.rpc('soft_delete_driver', {
      p_driver_id: userId,
    });
    if (softErr) {
      console.error('soft_delete_driver failed', softErr);
      return json({ error: 'soft delete failed' }, 500);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('delete-account failed', err);
    return json({ error: String(err) }, 500);
  }
});
