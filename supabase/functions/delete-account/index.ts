// Supabase Edge Function: delete-account
// POST /functions/v1/delete-account
// Auth: requires the caller's user JWT (Authorization: Bearer <token>).
//
// Final-step deletion — only proceeds when the account has passed the
// scheduled_for_deletion window (deletion_scheduled_for <= now()).
// This prevents immediate deletion from the client; the driver must go through
// the request → confirm → 48h wait flow first.
//
// Soft-deletes the driver row (anonymizes identifiable fields, retains the row
// so FK references from zone_visits remain valid). The auth.users row is
// intentionally retained so the email cannot be re-registered.

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

    // Guard: only delete accounts that have completed the confirmation flow and
    // whose 48-hour window has elapsed. This prevents any client-side bypass.
    const { data: driver, error: fetchErr } = await admin
      .from('drivers')
      .select('deletion_status, deletion_scheduled_for')
      .eq('id', userId)
      .maybeSingle();

    if (fetchErr) {
      console.error('[delete-account] driver lookup failed', fetchErr);
      return json({ error: 'could not verify deletion status' }, 500);
    }

    if (!driver) {
      return json({ error: 'driver not found' }, 404);
    }

    if (driver.deletion_status === 'deleted') {
      // Already deleted — idempotent success.
      return json({ ok: true });
    }

    if (driver.deletion_status !== 'scheduled_for_deletion') {
      return json({
        error: 'account is not scheduled for deletion — complete email confirmation first',
        deletion_status: driver.deletion_status,
      }, 409);
    }

    const scheduledFor = driver.deletion_scheduled_for
      ? new Date(driver.deletion_scheduled_for)
      : null;

    if (!scheduledFor || scheduledFor > new Date()) {
      const remaining = scheduledFor
        ? Math.ceil((scheduledFor.getTime() - Date.now()) / (60 * 60 * 1000))
        : null;
      return json({
        error: 'deletion window has not elapsed yet',
        deletion_scheduled_for: driver.deletion_scheduled_for,
        hours_remaining: remaining,
      }, 409);
    }

    // All checks passed — perform soft delete.
    const { error: softErr } = await admin.rpc('soft_delete_driver', {
      p_driver_id: userId,
    });
    if (softErr) {
      console.error('[delete-account] soft_delete_driver failed', softErr);
      return json({ error: 'soft delete failed' }, 500);
    }

    console.log(`[delete-account] soft-deleted driver ${userId}`);
    return json({ ok: true });
  } catch (err) {
    console.error('[delete-account] unexpected error', err);
    return json({ error: String(err) }, 500);
  }
});
