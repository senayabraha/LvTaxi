import React, { useEffect, useState } from 'react';

const MIN_WIDTH = 1024;

export default function DesktopOnlyGate({ children }) {
  const [w, setW] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : MIN_WIDTH
  );

  useEffect(() => {
    function onResize() {
      setW(window.innerWidth);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (w >= MIN_WIDTH) return children;

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="max-w-md text-center">
        <div className="text-accent text-4xl font-bold mb-3">🚕 LvTaxi Admin</div>
        <div className="text-text text-lg font-semibold mb-2">
          Desktop required
        </div>
        <div className="text-muted text-sm leading-relaxed mb-6">
          This admin tool is built for laptops and desktop monitors. Open
          it on a screen at least <span className="text-text">{MIN_WIDTH}px</span>{' '}
          wide.
        </div>
        <div className="text-muted text-xs">
          Your screen: {w}px
        </div>
      </div>
    </div>
  );
}
