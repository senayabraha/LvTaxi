import React, { useCallback, useEffect, useState } from 'react';
import ZonesPage from './ZonesPage.jsx';
import BuilderPage from './builder/BuilderPage.jsx';
import TrainingPage from './pages/TrainingPage.jsx';

const TAB = { ZONES: 'zones', BUILDER: 'builder', TRAINING: 'training' };

export default function MainTabs({ session, onSignOut }) {
  const [tab, setTab] = useState(TAB.ZONES);
  const [counts, setCounts] = useState({ total: 0, active: 0, coming: 0 });
  const [menuOpen, setMenuOpen] = useState(false);

  const handleCounts = useCallback((c) => setCounts(c), []);

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '1') setTab(TAB.ZONES);
      if (e.key === '2') setTab(TAB.BUILDER);
      if (e.key === '3') setTab(TAB.TRAINING);
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

          <div className="flex items-center gap-1.5 sm:gap-2">
            <TabButton
              label="Zones"
              shortcut="1"
              active={tab === TAB.ZONES}
              onClick={() => setTab(TAB.ZONES)}
            />
            <TabButton
              label="Builder"
              shortcut="2"
              active={tab === TAB.BUILDER}
              onClick={() => setTab(TAB.BUILDER)}
            />
            <TabButton
              label="Training"
              shortcut="3"
              active={tab === TAB.TRAINING}
              onClick={() => setTab(TAB.TRAINING)}
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
          {tab === TAB.ZONES ? (
            <>
              <span className="text-good font-medium">{counts.active}</span> active
              {' · '}
              <span className="text-warn font-medium">{counts.coming}</span>{' '}
              coming soon
              {' · '}
              <span className="text-text font-medium">{counts.total}</span> total
            </>
          ) : tab === TAB.BUILDER ? (
            <>Geofence Builder</>
          ) : (
            <>Route Training — draw reference paths to teach the ML model hotel loop routes</>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {tab === TAB.ZONES ? <ZonesPage onCounts={handleCounts} /> : null}
        {tab === TAB.BUILDER ? <BuilderPage /> : null}
        {tab === TAB.TRAINING ? <TrainingPage /> : null}
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
