import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import MetricStrip from '../components/MetricStrip.jsx';
import FilterBar from '../components/FilterBar.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../useToast.jsx';

const AUDIENCE_OPTIONS = [
  { value: 'all', label: 'All drivers with push token' },
  { value: 'active', label: 'Active / staged drivers' },
  { value: 'company', label: 'Taxi company' },
  { value: 'zone', label: 'Current zone' },
  { value: 'driver', label: 'One driver' },
];

function formatTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function driverLabel(driver) {
  const name = driver.full_name || driver.email || driver.phone || driver.id;
  const company = driver.taxi_company ? ` · ${driver.taxi_company}` : '';
  return `${name}${company}`;
}

export default function AnnouncementsPage() {
  const toast = useToast();
  const [drivers, setDrivers] = useState([]);
  const [zones, setZones] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const [title, setTitle] = useState('LV Taxi Announcement');
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState('all');
  const [driverId, setDriverId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [taxiCompany, setTaxiCompany] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [driversRes, zonesRes, notificationsRes] = await Promise.all([
      supabase
        .from('drivers')
        .select('id, full_name, email, phone, status, role, push_token, taxi_company, current_zone_id')
        .order('full_name', { ascending: true, nullsFirst: false }),
      supabase.from('staging_zones').select('id, name').order('name'),
      supabase
        .from('notifications')
        .select('id, driver_id, zone_id, type, message, created_at')
        .eq('type', 'admin_announcement')
        .order('created_at', { ascending: false })
        .limit(25),
    ]);

    if (driversRes.error) setError(driversRes.error.message);
    else setDrivers(driversRes.data ?? []);

    if (!zonesRes.error) setZones(zonesRes.data ?? []);
    if (!notificationsRes.error) setRecent(notificationsRes.data ?? []);

    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const companies = useMemo(() => {
    return Array.from(
      new Set(
        drivers
          .map((d) => d.taxi_company)
          .filter((company) => typeof company === 'string' && company.trim())
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [drivers]);

  const summary = useMemo(() => {
    const withToken = drivers.filter((d) => d.push_token).length;
    const active = drivers.filter((d) =>
      ['active', 'staged', 'passive_near'].includes(d.status)
    ).length;
    const activeWithToken = drivers.filter(
      (d) => d.push_token && ['active', 'staged', 'passive_near'].includes(d.status)
    ).length;
    return {
      total: drivers.length,
      withToken,
      active,
      activeWithToken,
    };
  }, [drivers]);

  const targetPreview = useMemo(() => {
    let list = drivers.filter((d) => d.push_token);
    if (audience === 'active') {
      list = list.filter((d) => ['active', 'staged', 'passive_near'].includes(d.status));
    } else if (audience === 'company') {
      list = list.filter((d) => d.taxi_company === taxiCompany);
    } else if (audience === 'zone') {
      list = list.filter((d) => d.current_zone_id === zoneId);
    } else if (audience === 'driver') {
      list = list.filter((d) => d.id === driverId);
    }
    return list;
  }, [audience, drivers, driverId, taxiCompany, zoneId]);

  const canSend = useMemo(() => {
    if (!title.trim() || !message.trim() || sending) return false;
    if (audience === 'driver' && !driverId) return false;
    if (audience === 'company' && !taxiCompany) return false;
    if (audience === 'zone' && !zoneId) return false;
    return true;
  }, [audience, driverId, message, sending, taxiCompany, title, zoneId]);

  async function sendAnnouncement() {
    if (!canSend) return;
    const confirmed = window.confirm(
      `Send this announcement to ${targetPreview.length} driver${
        targetPreview.length === 1 ? '' : 's'
      }?`
    );
    if (!confirmed) return;

    setSending(true);
    setResult(null);
    setError(null);

    const body = {
      title: title.trim(),
      message: message.trim(),
      type: 'admin_announcement',
      audience,
    };
    if (audience === 'driver') body.driver_id = driverId;
    if (audience === 'company') body.taxi_company = taxiCompany;
    if (audience === 'zone') body.zone_id = zoneId;

    const { data, error: invokeError } = await supabase.functions.invoke('send-push', {
      body,
    });

    setSending(false);

    if (invokeError) {
      const msg = invokeError.message || 'Could not send announcement.';
      setError(msg);
      toast?.(msg, 'error');
      return;
    }

    setResult(data);
    if (data?.ok) {
      toast?.(`Announcement sent to ${data.sent ?? 0} driver(s).`, 'success');
      setMessage('');
      load();
    } else {
      const msg = data?.error || 'Expo did not accept the push request.';
      setError(msg);
      toast?.(msg, 'error');
    }
  }

  return (
    <div className="flex flex-col h-full">
      <FilterBar summary={`Audience: ${AUDIENCE_OPTIONS.find((o) => o.value === audience)?.label ?? 'All'}`}>
        <button
          onClick={load}
          className="ml-auto bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
        >
          ↻ Refresh
        </button>
      </FilterBar>

      <MetricStrip
        items={[
          { label: 'Drivers', value: summary.total },
          { label: 'Push Tokens', value: summary.withToken, tone: 'good' },
          { label: 'Active', value: summary.active, tone: 'accent' },
          { label: 'Active + Token', value: summary.activeWithToken, tone: 'warn' },
        ]}
      />

      <main className="flex-1 overflow-auto p-3 sm:p-6">
        {error ? (
          <div className="bg-bad/20 border border-bad/30 text-bad rounded-lg px-4 py-3 text-sm mb-4">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
          <section className="bg-panel border border-border rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h1 className="text-text text-xl font-bold">Send Announcement</h1>
                <p className="text-muted text-sm mt-1">
                  Broadcast important LV Taxi updates to drivers through Expo push notifications.
                </p>
              </div>
              <StatusBadge tone="accent">Admin only</StatusBadge>
            </div>

            <label className="block text-muted text-xs mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              placeholder="LV Taxi Announcement"
              className="w-full bg-bg border border-border rounded px-3 py-2 text-text mb-3"
            />

            <label className="block text-muted text-xs mb-1">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={220}
              rows={5}
              placeholder="Example: Airport T1 is moving fast right now. Estimated wait is under 10 minutes."
              className="w-full bg-bg border border-border rounded px-3 py-2 text-text mb-2 resize-y"
            />
            <div className="text-muted text-xs text-right mb-4">{message.length}/220</div>

            <label className="block text-muted text-xs mb-1">Audience</label>
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-text mb-3"
            >
              {AUDIENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            {audience === 'driver' ? (
              <>
                <label className="block text-muted text-xs mb-1">Driver</label>
                <select
                  value={driverId}
                  onChange={(e) => setDriverId(e.target.value)}
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-text mb-3"
                >
                  <option value="">Select driver…</option>
                  {drivers
                    .filter((d) => d.push_token)
                    .map((driver) => (
                      <option key={driver.id} value={driver.id}>
                        {driverLabel(driver)}
                      </option>
                    ))}
                </select>
              </>
            ) : null}

            {audience === 'company' ? (
              <>
                <label className="block text-muted text-xs mb-1">Taxi company</label>
                <select
                  value={taxiCompany}
                  onChange={(e) => setTaxiCompany(e.target.value)}
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-text mb-3"
                >
                  <option value="">Select company…</option>
                  {companies.map((company) => (
                    <option key={company} value={company}>
                      {company}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            {audience === 'zone' ? (
              <>
                <label className="block text-muted text-xs mb-1">Current zone</label>
                <select
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                  className="w-full bg-bg border border-border rounded px-3 py-2 text-text mb-3"
                >
                  <option value="">Select zone…</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <div className="bg-bg border border-border rounded-lg px-4 py-3 mb-4">
              <div className="text-muted text-xs mb-1">Target preview</div>
              <div className="text-text text-lg font-bold">
                {targetPreview.length} driver{targetPreview.length === 1 ? '' : 's'} with push token
              </div>
              <div className="text-muted text-xs mt-1">
                Drivers without saved push tokens are automatically skipped.
              </div>
            </div>

            <button
              onClick={sendAnnouncement}
              disabled={!canSend}
              className={`w-full rounded-lg px-4 py-3 font-semibold ${
                canSend
                  ? 'bg-accent text-bg hover:opacity-90'
                  : 'bg-panel2 border border-border text-muted cursor-not-allowed'
              }`}
            >
              {sending ? 'Sending…' : 'Send Announcement'}
            </button>

            {result ? (
              <pre className="mt-4 bg-bg border border-border rounded-lg p-3 text-xs text-muted overflow-auto max-h-56">
                {JSON.stringify(result, null, 2)}
              </pre>
            ) : null}
          </section>

          <aside className="bg-panel border border-border rounded-lg p-4 min-h-[240px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-text font-semibold">Recent announcements</h2>
              {loading ? <span className="text-muted text-xs">Loading…</span> : null}
            </div>

            {recent.length === 0 ? (
              <div className="text-muted text-sm">No announcement logs yet.</div>
            ) : (
              <div className="space-y-3">
                {recent.slice(0, 12).map((row) => (
                  <div key={row.id} className="bg-bg border border-border rounded p-3">
                    <div className="text-text text-sm line-clamp-3">{row.message}</div>
                    <div className="text-muted text-xs mt-2 flex items-center justify-between gap-2">
                      <span>{formatTime(row.created_at)}</span>
                      {row.zone_id ? <span>Zone-targeted</span> : <span>Broadcast</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
