import React, { useCallback, useEffect, useState } from 'react';
import ZonesPage from './ZonesPage.jsx';
import BuilderPage from './builder/BuilderPage.jsx';

const TAB = { ZONES: 'zones', BUILDER: 'builder' };

export default function MainTabs({ session, onSignOut }) {
  const [tab, setTab] = useState(TAB.ZONES);
  const [counts, setCounts] = useState({ total: 0, active: 0, coming: 0 });

  const handleCounts = useCallback(
    (c) => setCounts(c),
    []
  );

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '1') setTab(TAB.ZONES);
      if (e.key === '2') setTab(TAB.BUILDER);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-col h-full bg-bg">
      <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-panel">
        <div className="flex items-baseline gap-6">
          <div className="text-accent text-2xl font-bold">🚕 LvTaxi Admin</div>
          {tab === TAB.ZONES ? (
            <div className="text-muted text-sm">
              <span className="text-good font-medium">{counts.active}</span> active
              ·{' '}
              <span className="text-warn font-medium">{counts.coming}</span>{' '}
              coming soon ·{' '}
              <span className="text-text font-medium">{counts.total}</span> total
            </div>
          ) : (
            <div className="text-muted text-sm">Geofence Builder</div>
          )}
        </div>
        <div className="flex items-center gap-2">
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
          <div className="w-px h-6 bg-border mx-2" />
          <div className="text-muted text-xs">
            {session.user.email ?? session.user.phone}
          </div>
          <button
            onClick={onSignOut}
            className="bg-panel2 border border-border text-muted px-3 py-1.5 rounded text-sm hover:text-text"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {tab === TAB.ZONES ? <ZonesPage onCounts={handleCounts} /> : null}
        {tab === TAB.BUILDER ? <BuilderPage /> : null}
      </div>
    </div>
  );
}

function TabButton({ label, shortcut, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 ${
        active
          ? 'bg-accent text-bg'
          : 'bg-panel2 border border-border text-muted hover:text-text'
      }`}
      title={`Shortcut: ${shortcut}`}
    >
      {label}
      <span
        className={`text-[10px] font-mono ${
          active ? 'text-bg/70' : 'text-muted'
        }`}
      >
        {shortcut}
      </span>
    </button>
  );
}
