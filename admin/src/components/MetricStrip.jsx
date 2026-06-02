import React from 'react';
import SummaryCard from './SummaryCard.jsx';

const PILL_TONE = {
  text: 'text-text',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  accent: 'text-accent',
};

// Shows summary metrics as compact horizontally-scrollable pills on mobile and
// as the existing larger cards on desktop/tablet.
// items: [{ label, value, tone, hint }]
export default function MetricStrip({ items }) {
  return (
    <>
      {/* Mobile: scrollable pills */}
      <div className="sm:hidden flex gap-2 overflow-x-auto no-scrollbar px-3 py-2 border-b border-border">
        {items.map((it) => (
          <span
            key={it.label}
            className="inline-flex items-center gap-1.5 bg-panel border border-border rounded-full px-3 py-1.5 text-xs whitespace-nowrap shrink-0"
          >
            <span className="text-muted">{it.label}</span>
            <span className={`font-bold tabular-nums ${PILL_TONE[it.tone] ?? PILL_TONE.text}`}>
              {it.value}
            </span>
          </span>
        ))}
      </div>

      {/* Desktop/tablet: cards */}
      <div className="hidden sm:flex flex-wrap gap-3 px-6 py-4 border-b border-border">
        {items.map((it) => (
          <SummaryCard
            key={it.label}
            label={it.label}
            value={it.value}
            tone={it.tone}
            hint={it.hint}
          />
        ))}
      </div>
    </>
  );
}
