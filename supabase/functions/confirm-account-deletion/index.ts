// Supabase Edge Function: confirm-account-deletion
// GET /functions/v1/confirm-account-deletion?token=<uuid>
// Public — no auth required (called from a browser via the email link).
//
// Validates the one-time token, then schedules the account for deletion
// 48 hours from now. Returns an HTML page the driver sees in their browser.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const PAGE = (title: string, message: string, isError = false) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} – LV Taxi</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0B0F1A; color: #E2E8F0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #151A27; border: 1px solid #2D3449; border-radius: 12px;
      padding: 32px 28px; max-width: 480px; width: 100%; text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 12px;
         color: ${isError ? '#E5484D' : '#F5C518'}; }
    p { color: #8B9CB0; line-height: 1.6; font-size: 0.95rem; }
    .highlight { color: #E2E8F0; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isError ? '⚠️' : '🗑️'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

serve(async (req) => {
  if (req.method !== 'GET') {
    return html(PAGE('Method not allowed', 'Only GET requests are supported.', true), 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const secretKey =
      Deno.env.get('SUPABASE_SECRET_KEY') ??
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SERVICE_ROLE_KEY') ??
      '';

    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return html(PAGE(
        'Invalid link',
        'This confirmation link is missing a token. Please request a new deletion email from the app.',
        true
      ), 400);
    }

    const admin = createClient(supabaseUrl, secretKey);

    // Look up a driver with this token that hasn't expired and is still pending.
    const { data: driver, error: fetchErr } = await admin
      .from('drivers')
      .select('id, deletion_status, deletion_token_expires_at')
      .eq('deletion_token', token)
      .eq('deletion_status', 'pending_email_confirmation')
      .maybeSingle();

    if (fetchErr) {
      console.error('[confirm-account-deletion] DB lookup failed', fetchErr);
      return html(PAGE('Something went wrong', 'Please try again later or contact support@lvtaxi.online.', true), 500);
    }

    if (!driver) {
      return html(PAGE(
        'Link expired or already used',
        'This confirmation link is no longer valid. If you still want to delete your account, please make a new request from the app.',
        true
      ), 410);
    }

    // Check token expiry.
    const expiresAt = driver.deletion_token_expires_at
      ? new Date(driver.deletion_token_expires_at)
      : null;
    if (!expiresAt || expiresAt < new Date()) {
      return html(PAGE(
        'Link expired',
        'This confirmation link has expired. Please request a new deletion email from the app.',
        true
      ), 410);
    }

    const scheduledFor = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Schedule deletion.
    const { error: updateErr } = await admin
      .from('drivers')
      .update({
        deletion_status: 'scheduled_for_deletion',
        deletion_confirmed_at: new Date().toISOString(),
        deletion_scheduled_for: scheduledFor.toISOString(),
        deletion_token: null,           // invalidate — one-time use
        deletion_token_expires_at: null,
      })
      .eq('id', driver.id);

    if (updateErr) {
      console.error('[confirm-account-deletion] schedule update failed', updateErr);
      return html(PAGE('Something went wrong', 'Could not schedule deletion. Please try again or contact support@lvtaxi.online.', true), 500);
    }

    const deletionDateStr = scheduledFor.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    console.log(`[confirm-account-deletion] scheduled deletion for driver ${driver.id} at ${scheduledFor.toISOString()}`);

    return html(PAGE(
      'Account deletion scheduled',
      `Your LV Taxi account is scheduled for permanent deletion on <span class="highlight">${deletionDateStr}</span>.
       <br/><br/>
       If you change your mind, simply sign back in to the app before that time — your deletion will be canceled automatically.`
    ));
  } catch (err) {
    console.error('[confirm-account-deletion] unexpected error', err);
    return html(PAGE('Something went wrong', 'An unexpected error occurred. Please contact support@lvtaxi.online.', true), 500);
  }
});
