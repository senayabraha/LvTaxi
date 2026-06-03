// Supabase Edge Function: cancel-account-deletion
// POST /functions/v1/cancel-account-deletion
// Auth: requires the caller's user JWT (Authorization: Bearer <token>).
//
// Cancels a pending 'scheduled_for_deletion' request. Idempotent — safe to
// call even if no deletion is scheduled (returns { ok: true, cancelled: false }).

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
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const publishableKey =
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ??
      Deno.env.get('SUPABASE_ANON_KEY') ??
      '';
    const secretKey =
      Deno.env.get('SUPABASE_SECRET_KEY') ??
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SERVICE_ROLE_KEY') ??
      '';

    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'missing bearer token' }, 401);
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);

    const userId = userData.user.id;
    const admin = createClient(supabaseUrl, secretKey);

    // Call the stored procedure which handles idempotency.
    const { data: cancelled, error: rpcErr } = await admin.rpc('cancel_account_deletion', {
      p_driver_id: userId,
    });

    if (rpcErr) {
      console.error('[cancel-account-deletion] RPC failed', rpcErr);
      return json({ error: 'could not cancel deletion' }, 500);
    }

    console.log(`[cancel-account-deletion] driver ${userId} cancelled=${cancelled}`);
    return json({ ok: true, cancelled: cancelled ?? false });
  } catch (err) {
    console.error('[cancel-account-deletion] unexpected error', err);
    return json({ error: String(err) }, 500);
  }
});
