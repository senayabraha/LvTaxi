import React, { useState } from 'react';

// Collapsible help / description block.
// - Mobile: collapsed by default behind a small "ⓘ Help" toggle.
// - Desktop (sm+): always shown, no toggle.
export default function InfoHelp({ children, className = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="sm:hidden inline-flex items-center gap-1 text-muted text-xs px-2 py-1 rounded bg-panel2 border border-border"
      >
        ⓘ Help <span className="text-[10px]">{open ? '▲' : '▼'}</span>
      </button>
      <div
        className={`${open ? 'block' : 'hidden'} sm:block text-muted text-xs mt-2 sm:mt-0`}
      >
        {children}
      </div>
    </div>
  );
}
