import React from 'react';

// Reusable colored pill badge. `tone` maps to the dark-theme palette.
// Tones: good | warn | bad | accent | muted (default).
const TONES = {
  good: 'bg-good/20 text-good',
  warn: 'bg-warn/20 text-warn',
  bad: 'bg-bad/20 text-bad',
  accent: 'bg-accent/20 text-accent',
  muted: 'bg-panel2 text-muted',
};

export default function StatusBadge({ tone = 'muted', children, title }) {
  const cls = TONES[tone] ?? TONES.muted;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${cls}`}
    >
      {children}
    </span>
  );
}

// Maps a health label (GOOD/WARNING/CRITICAL/UNKNOWN) to a badge.
export function HealthBadge({ health, title }) {
  const map = {
    GOOD: { tone: 'good', label: 'Good' },
    WARNING: { tone: 'warn', label: 'Warning' },
    CRITICAL: { tone: 'bad', label: 'Critical' },
    UNKNOWN: { tone: 'muted', label: 'Unknown' },
  };
  const m = map[health] ?? map.UNKNOWN;
  return (
    <StatusBadge tone={m.tone} title={title}>
      {m.label}
    </StatusBadge>
  );
}
