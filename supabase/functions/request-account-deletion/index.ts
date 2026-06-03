// Supabase Edge Function: request-account-deletion
// POST /functions/v1/request-account-deletion
// Auth: requires the caller's user JWT (Authorization: Bearer <token>).
//
// Immediately starts the 48-hour deletion timer. No email confirmation step.
// Idempotent: re-requesting while a timer is already running resets it.
//
// TODO: when email is ready, add a confirmation email step here and switch
// deletion_status to 'pending_email_confirmation' until the driver clicks the link.

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
    const scheduledFor = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const admin = createClient(supabaseUrl, secretKey);
    const { error: updateErr } = await admin
      .from('drivers')
      .update({
        deletion_status: 'scheduled_for_deletion',
        deletion_requested_at: now,
        deletion_confirmed_at: now,
        deletion_scheduled_for: scheduledFor,
        deletion_cancelled_at: null,
        deletion_token: null,
        deletion_token_expires_at: null,
      })
      .eq('id', userId);

    if (updateErr) {
      console.error('[request-account-deletion] DB update failed', updateErr);
      return json({ error: 'could not schedule deletion' }, 500);
    }

    console.log(`[request-account-deletion] deletion scheduled for driver ${userId} at ${scheduledFor}`);
    return json({ ok: true, deletion_scheduled_for: scheduledFor });
  } catch (err) {
    console.error('[request-account-deletion] unexpected error', err);
    return json({ error: String(err) }, 500);
  }
});
