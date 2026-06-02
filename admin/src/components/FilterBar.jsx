import React, { useState } from 'react';

// Collapsible filter/control container.
// - Mobile: collapsed behind a "Filters" button with a one-line summary of the
//   current selection; tapping reveals the full controls (children).
// - Desktop (sm+): always expanded.
//
// Props:
//   summary  — short string shown next to the Filters button when collapsed.
//   children — the full set of search/filter/sort/action controls.
export default function FilterBar({ summary, children, className = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border-b border-border bg-panel/40 ${className}`}>
      {/* Mobile: summary row */}
      <div className="sm:hidden flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 inline-flex items-center gap-1 bg-panel2 border border-border text-text text-xs px-2.5 py-1.5 rounded"
        >
          ⚙ Filters <span className="text-[10px]">{open ? '▲' : '▼'}</span>
        </button>
        {summary ? (
          <div className="text-muted text-xs truncate">{summary}</div>
        ) : null}
      </div>

      {/* Controls — hidden on mobile unless open, always shown on desktop */}
      <div
        className={`${open ? 'flex' : 'hidden'} sm:flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-6 pb-3 sm:py-3`}
      >
        {children}
      </div>
    </div>
  );
}
