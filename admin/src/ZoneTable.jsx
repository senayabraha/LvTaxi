import React from 'react';
import ZoneRow from './ZoneRow.jsx';

export default function ZoneTable({ zones, stats, onUpdate }) {
  if (zones.length === 0) {
    return (
      <div className="text-muted text-center py-12">No zones match the filter.</div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-bg border-b border-border">
        <tr className="text-muted text-xs uppercase tracking-wide">
          <th className="text-left px-6 py-3">Name</th>
          <th className="text-left px-3 py-3">Phase</th>
          <th className="text-left px-3 py-3">Polygons</th>
          <th className="text-center px-3 py-3">Active</th>
          <th className="text-center px-3 py-3">Coming Soon</th>
          <th
            className="text-center px-3 py-3"
            title="Use the recorded (driven) polygon for detection"
          >
            Use Phase B
          </th>
          <th className="text-right px-3 py-3">Cars</th>
          <th className="text-right px-3 py-3">Wait</th>
          <th className="text-right px-6 py-3">Updated</th>
        </tr>
      </thead>
      <tbody>
        {zones.map((z) => (
          <ZoneRow
            key={z.id}
            zone={z}
            stat={stats[z.id]}
            onUpdate={onUpdate}
          />
        ))}
      </tbody>
    </table>
  );
}
