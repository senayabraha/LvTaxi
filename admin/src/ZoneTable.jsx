import React from 'react';
import ZoneRow from './ZoneRow.jsx';

export default function ZoneTable({ zones, stats, onUpdate, onDelete, onPreview, onEditCircle }) {
  if (zones.length === 0) {
    return (
      <div className="text-muted text-center py-12">No zones match the filter.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: 960 }}>
        <thead className="sticky top-0 bg-bg border-b border-border">
          <tr className="text-muted text-xs uppercase tracking-wide">
            <th className="text-left px-3 sm:px-6 py-3">Name</th>
            <th className="text-left px-2 sm:px-3 py-3">Phase</th>
            <th className="text-left px-2 sm:px-3 py-3">Polygons</th>
            <th className="text-center px-2 sm:px-3 py-3">Active</th>
            <th className="text-center px-2 sm:px-3 py-3">Coming Soon</th>
            <th
              className="text-center px-2 sm:px-3 py-3"
              title="Use the recorded (driven) polygon for detection"
            >
              Use Phase B
            </th>
            <th
              className="text-center px-2 sm:px-3 py-3"
              title="Visible to drivers in the app"
            >
              Visible
            </th>
            <th
              className="text-center px-2 sm:px-3 py-3"
              title="Native OS geofence circle active"
            >
              Circle
            </th>
            <th className="text-right px-2 sm:px-3 py-3">Cars</th>
            <th className="text-right px-2 sm:px-3 py-3">Wait</th>
            <th className="text-right px-3 sm:px-6 py-3">Updated</th>
            <th className="text-right px-2 sm:px-3 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z) => (
            <ZoneRow
              key={z.id}
              zone={z}
              stat={stats[z.id]}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onPreview={onPreview}
              onEditCircle={onEditCircle}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
