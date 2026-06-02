import React, { useCallback, useEffect, useState, Suspense, lazy } from 'react';
import ZonesPage from './ZonesPage.jsx';
import LiveOpsPage from './pages/LiveOpsPage.jsx';

// Heavier / less-frequently-used pages are code-split to shrink the initial
// bundle. Live Ops and Zones (the default landing views) stay eager.
const BuilderPage = lazy(() => import('./builder/BuilderPage.jsx'));
const TrainingPage = lazy(() => import('./pages/TrainingPage.jsx'));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx'));
const DriversPage = lazy(() => import('./pages/DriversPage.jsx'));
const TrainingRoutesPage = lazy(() => import('./pages/TrainingRoutesPage.jsx'));
const SystemCheckPage = lazy(() => import('./pages/SystemCheckPage.jsx'));

const TAB = {
  LIVE: 'live',
  ZONES: 'zones',
  DRIVERS: 'drivers',
  ROUTES: 'routes',
  BUILDER: 'builder',
  TRAINING: 'training',
  AUDIT: 'audit',
  SYSTEM: 'system',
};

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
      if (e.key === '1') setTab(TAB.LIVE);
      if (e.key === '2') setTab(TAB.ZONES);
      if (e.key === '3') setTab(TAB.DRIVERS);
      if (e.key === '4') setTab(TAB.ROUTES);
      if (e.key === '5') setTab(TAB.BUILDER);
      if (e.key === '6') setTab(TAB.TRAINING);
      if (e.key === '7') setTab(TAB.AUDIT);
      if (e.key === '8') setTab(TAB.SYSTEM);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const userLabel = session.user.email ?? session.user.phone ?? '—';

  return (
    <div className="flex flex-col h-full bg-bg">
      <header className="border-b border-border bg-panel">
        {/* Row 1: brand + tabs + account menu */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-2 gap-2">
          <div className="text-accent text-lg sm:text-2xl font-bold whitespace-nowrap">
            🚕 LvTaxi Admin
          </div>

          <div className="flex items-center flex-wrap justify-end gap-1.5 sm:gap-2">
            <TabButton
              label="Live Ops"
              shortcut="1"
              active={tab === TAB.LIVE}
              onClick={() => setTab(TAB.LIVE)}
            />
            <TabButton
              label="Zones"
              shortcut="2"
              active={tab === TAB.ZONES}
              onClick={() => setTab(TAB.ZONES)}
            />
            <TabButton
              label="Drivers"
              shortcut="3"
              active={tab === TAB.DRIVERS}
              onClick={() => setTab(TAB.DRIVERS)}
            />
            <TabButton
              label="Routes"
              shortcut="4"
              active={tab === TAB.ROUTES}
              onClick={() => setTab(TAB.ROUTES)}
            />
            <TabButton
              label="Builder"
              shortcut="5"
              active={tab === TAB.BUILDER}
              onClick={() => setTab(TAB.BUILDER)}
            />
            <TabButton
              label="Training"
              shortcut="6"
              active={tab === TAB.TRAINING}
              onClick={() => setTab(TAB.TRAINING)}
            />
            <TabButton
              label="Audit"
              shortcut="7"
              active={tab === TAB.AUDIT}
              onClick={() => setTab(TAB.AUDIT)}
            />
            <TabButton
              label="System"
              shortcut="8"
              active={tab === TAB.SYSTEM}
              onClick={() => setTab(TAB.SYSTEM)}
            />

            {/* Desktop: show email + sign out inline */}
            <div className="hidden md:flex items-center gap-2 ml-2 pl-3 border-l border-border">
              <div className="text-muted text-xs max-w-[180px] truncate">
                {userLabel}
              </div>
              <button
                onClick={onSignOut}
                className="bg-panel2 border border-border text-muted px-3 py-1.5 rounded text-sm hover:text-text"
              >
                Sign out
              </button>
            </div>

            {/* Mobile: hamburger that opens the account menu */}
            <div className="md:hidden relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="bg-panel2 border border-border text-muted w-9 h-9 rounded flex items-center justify-center"
                aria-label="Account menu"
              >
                ⋮
              </button>
              {menuOpen ? (
                <div
                  className="absolute right-0 top-11 z-50 bg-panel2 border border-border rounded shadow-lg py-2 w-56"
                  onClick={() => setMenuOpen(false)}
                >
                  <div className="px-3 py-1 text-muted text-xs truncate">
                    {userLabel}
                  </div>
                  <button
                    onClick={onSignOut}
                    className="w-full text-left px-3 py-2 text-bad text-sm hover:bg-panel"
                  >
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Row 2: context line (counts / page name) */}
        <div className="px-3 sm:px-6 pb-2 text-muted text-xs">
          {tab === TAB.LIVE ? (
            <>Live zone health and wait confidence</>
          ) : tab === TAB.ZONES ? (
            <>
              <span className="text-good font-medium">{counts.active}</span> active
              {' · '}
              <span className="text-warn font-medium">{counts.coming}</span>{' '}
              coming soon
              {' · '}
              <span className="text-text font-medium">{counts.total}</span> total
            </>
          ) : tab === TAB.DRIVERS ? (
            <>Driver roster, presence and classification</>
          ) : tab === TAB.ROUTES ? (
            <>Saved training routes — preview and manage reference paths</>
          ) : tab === TAB.BUILDER ? (
            <>Geofence Builder</>
          ) : tab === TAB.TRAINING ? (
            <>Route Training — draw reference paths to teach the ML model hotel loop routes</>
          ) : tab === TAB.SYSTEM ? (
            <>System health — connectivity and RLS access checks</>
          ) : (
            <>Admin change history</>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<PageFallback />}>
          {tab === TAB.LIVE ? <LiveOpsPage /> : null}
          {tab === TAB.ZONES ? <ZonesPage onCounts={handleCounts} /> : null}
          {tab === TAB.DRIVERS ? <DriversPage /> : null}
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
      className={`px-2.5 sm:px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 ${
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
