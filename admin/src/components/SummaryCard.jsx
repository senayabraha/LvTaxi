import React from 'react';

// Small dashboard summary card. `tone` colors the main value.
// Tones: text (default) | good | warn | bad | accent.
const VALUE_TONES = {
  text: 'text-text',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  accent: 'text-accent',
};

export default function SummaryCard({ label, value, tone = 'text', hint }) {
  const valueCls = VALUE_TONES[tone] ?? VALUE_TONES.text;
  return (
    <div className="bg-panel border border-border rounded-lg px-4 py-3 flex flex-col gap-1 min-w-[120px]">
      <div className="text-muted text-[11px] uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${valueCls}`}>{value}</div>
      {hint ? <div className="text-muted text-[11px]">{hint}</div> : null}
    </div>
  );
}
