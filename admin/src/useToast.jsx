import React, { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext(null);
let _nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const remove = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const add = useCallback(
    (msg, type = 'info') => {
      const id = ++_nextId;
      setToasts((t) => [...t, { id, msg, type }]);
      setTimeout(() => remove(id), 4000);
    },
    [remove]
  );

  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
        style={{ maxWidth: 360 }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => remove(t.id)}
            className={`flex items-start justify-between gap-3 px-4 py-3 rounded shadow-lg cursor-pointer text-sm font-medium pointer-events-auto ${
              t.type === 'success'
                ? 'bg-good text-white'
                : t.type === 'error'
                ? 'bg-bad text-white'
                : 'bg-panel2 border border-border text-text'
            }`}
          >
            <span className="flex-1">{t.msg}</span>
            <span className="opacity-50 mt-0.5 shrink-0">✕</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
