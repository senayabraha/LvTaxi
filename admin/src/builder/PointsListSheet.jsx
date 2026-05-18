import React from 'react';

export default function PointsListSheet({ open, points, title, onDelete, onClose }) {
  if (!open) return null;
  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-[1500]"
        onClick={onClose}
      />
      <div className="fixed inset-x-0 bottom-0 z-[1600] bg-panel border-t border-border rounded-t-2xl max-h-[70vh] flex flex-col">
        <div className="flex justify-center py-2 cursor-pointer" onClick={onClose}>
          <div className="w-10 h-1 bg-muted/60 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2 border-b border-border">
          <div className="text-text font-semibold text-sm">{title}</div>
          <button
            onClick={onClose}
            className="bg-panel2 border border-border text-muted w-8 h-8 rounded-full"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {points.length === 0 ? (
            <div className="text-muted text-center py-8 text-sm">No points yet</div>
          ) : (
            points.map((p, i) => (
              <div
                key={p.id ?? i}
                className="flex items-center gap-3 px-4 py-2.5 border-b border-border/60 last:border-b-0"
              >
                <span className="text-muted text-xs font-semibold w-6 text-right">
                  {i + 1}
                </span>
                {p.type ? (
                  <span
                    className={`text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${
                      p.type === 'manual'
                        ? 'bg-good/20 text-good'
                        : 'bg-blue-500/20 text-blue-400'
                    }`}
                  >
                    {p.type}
                  </span>
                ) : (
                  <span className="text-[10px] font-bold uppercase rounded px-1.5 py-0.5 bg-purple-500/20 text-purple-400">
                    drawn
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-text text-xs tabular-nums truncate">
                    {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                  </div>
                  {p.accuracy != null ? (
                    <div className="text-muted text-[10px]">
                      ±{Math.round(p.accuracy)}m
                    </div>
                  ) : null}
                </div>
                <button
                  onClick={() => onDelete(i)}
                  className="bg-bad/20 text-bad w-8 h-8 rounded text-sm"
                  aria-label="Delete point"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
