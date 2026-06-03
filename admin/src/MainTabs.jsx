import React, { useCallback, useEffect, useState, Suspense, lazy } from 'react';
import ZonesPage from './ZonesPage.jsx';
import LiveOpsPage from './pages/LiveOpsPage.jsx';

// Heavier / less-frequently-used pages are code-split to shrink the initial
// bundle. Live Ops and Zones (the default landing views) stay eager.
const BuilderPage = lazy(() => import('./builder/BuilderPage.jsx'));
const TrainingPage = lazy(() => import('./pages/TrainingPage.jsx'));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx'));
const DriversPage = lazy(() => import('./pages/DriversPage.jsx'));
const AnnouncementsPage = lazy(() => import('./pages/AnnouncementsPage.jsx'));
const TrainingRoutesPage = lazy(() => import('./pages/TrainingRoutesPage.jsx'));
const SystemCheckPage = lazy(() => import('./pages/SystemCheckPage.jsx'));

const TAB = {
  LIVE: 'live',
  ZONES: 'zones',
  DRIVERS: 'drivers',
  ANNOUNCEMENTS: 'announcements',
  ROUTES: 'routes',
  BUILDER: 'builder',
  TRAINING: 'training',
  AUDIT: 'audit',
  SYSTEM: 'system',
};

// Order + labels for the horizontal tab bar. Shortcuts are the 1-based index.
const TABS = [
  { key: TAB.LIVE, label: 'Live Ops' },
  { key: TAB.ZONES, label: 'Zones' },
  { key: TAB.DRIVERS, label: 'Drivers' },
  { key: TAB.ANNOUNCEMENTS, label: 'Announcements' },
  { key: TAB.ROUTES, label: 'Routes' },
  { key: TAB.BUILDER, label: 'Builder' },
  { key: TAB.TRAINING, label: 'Training' },
  { key: TAB.AUDIT, label: 'Audit' },
  { key: TAB.SYSTEM, label: 'System' },
];

function PageFallback() {
  return <div className="text-muted text-center py-12">Loading…</div>;
}

export default function MainTabs({ session, onSignOut }) {
  const [tab, setTab] = useState(TAB.ZONES);
  const [counts, setCounts] = useState({ total: 0, active: 0, coming: 0 });
  const [menuOpen, setMenuOpen] = useState(false);

  const handleCounts = useCallback((c) => setCounts(c), []);

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < TABS.length) setTab(TABS[idx].key);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const userLabel = session.user.email ?? session.user.phone ?? '—';
  const activeLabel = TABS.find((t) => t.key === tab)?.label ?? '';

  // Compact subtitle shown in the header: zone counts on the Zones tab,
  // otherwise the active section name.
  const subtitle =
    tab === TAB.ZONES
      ? `${counts.active} active · ${counts.total} total`
      : activeLabel;

  return (
    <div className="flex flex-col h-[100dvh] bg-bg">
      {/* ── Sticky layer 1: compact header ───────────────────────────────── */}
      <header className="shrink-0 h-[52px] flex items-center justify-between gap-3 px-3 sm:px-6 bg-panel border-b border-border">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-accent text-base sm:text-xl font-bold whitespace-nowrap">
            🚕 LvTaxi
          </span>
          <span className="text-muted text-xs sm:text-sm truncate">{subtitle}</span>
        </div>
        <div className="text-muted text-xs hidden sm:block max-w-[180px] truncate">
          {userLabel}
        </div>
      </header>

      {/* ── Sticky layer 2: horizontal tab bar ───────────────────────────── */}
      <nav className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 bg-panel border-b border-border">
        {/* Only the tab list scrolls horizontally. The overflow container is
            kept separate from the More menu so the dropdown (which opens below
            the bar) isn't clipped by overflow-x/overflow-y. */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0">
          {TABS.map((t, i) => (
            <TabButton
              key={t.key}
              label={t.label}
              shortcut={i + 1}
              active={tab === t.key}
              onClick={() => setTab(t.key)}
            />
          ))}
        </div>

        {/* More: account menu (email + sign out) */}
        <div className="relative shrink-0 ml-2">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap bg-panel2 border border-border text-muted hover:text-text"
          >
            More ⋯
          </button>
          {menuOpen ? (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-10 z-50 bg-panel2 border border-border rounded shadow-lg py-2 w-56">
                <div className="px-3 py-1 text-muted text-xs truncate">{userLabel}</div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onSignOut();
                  }}
                  className="w-full text-left px-3 py-2 text-bad text-sm hover:bg-panel"
                >
                  Sign out
                </button>
              </div>
            </>
          ) : null}
        </div>
      </nav>

      {/* ── Scrolling content (everything else) ──────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<PageFallback />}>
          {tab === TAB.LIVE ? <LiveOpsPage /> : null}
          {tab === TAB.ZONES ? <ZonesPage onCounts={handleCounts} /> : null}
          {tab === TAB.DRIVERS ? <DriversPage /> : null}
          {tab === TAB.ANNOUNCEMENTS ? <AnnouncementsPage /> : null}
          {tab === TAB.ROUTES ? <TrainingRoutesPage /> : null}
          {tab === TAB.BUILDER ? <BuilderPage /> : null}
          {tab === TAB.TRAINING ? <TrainingPage /> : null}
          {tab === TAB.AUDIT ? <AuditPage /> : null}
          {tab === TAB.SYSTEM ? <SystemCheckPage /> : null}
        </Suspense>
      </div>
    </div>
  );
}

function TabButton({ label, shortcut, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap flex items-center gap-1.5 ${
        active
          ? 'bg-accent text-bg'
          : 'bg-panel2 border border-border text-muted hover:text-text'
      }`}
      title={`Shortcut: ${shortcut}`}
    >
      {label}
      <span
        className={`hidden sm:inline text-[10px] font-mono ${
          active ? 'text-bg/70' : 'text-muted'
        }`}
      >
        {shortcut}
      </span>
    </button>
  );
}
