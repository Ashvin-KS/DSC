import React, { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { useIntentStore } from '../../store/useIntentStore';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface AppLayoutProps {
  children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
  const settings = useIntentStore((s) => s.settings);
  const fontScale = settings?.fontScale || 1;
  const compactMode = settings?.compactMode || false;

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Tailwind uses rem for sizing. To scale the entire UI (text and spacing), 
    // we must change the root html element's font-size.
    document.documentElement.style.fontSize = `${fontScale * 100}%`;
  }, [fontScale]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const checkMaximized = async () => {
      try {
        const appWindow = getCurrentWindow();
        const max = await appWindow.isMaximized();
        setIsMaximized(max);
      } catch (err) {
        // Safe to ignore in non-Tauri environments
      }
    };

    checkMaximized();

    try {
      getCurrentWindow().listen('tauri://resize', checkMaximized)
        .then((unsub) => {
          unlisten = unsub;
        })
        .catch(() => {});
    } catch (err) {
      // Safe to ignore in non-Tauri environments
    }

    return () => {
      if (unlisten) {
        try { unlisten(); } catch {}
      }
    };
  }, []);

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.warn('Failed to minimize window:', err);
    }
  };

  const handleMaximize = async () => {
    try {
      const appWindow = getCurrentWindow();
      const max = await appWindow.isMaximized();
      if (max) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      setIsMaximized(!max);
    } catch (err) {
      console.warn('Failed to toggle maximize:', err);
    }
  };

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.warn('Failed to close window:', err);
    }
  };

  return (
    <div
      className="flex h-screen w-full overflow-hidden font-sans relative"
      style={{ background: 'var(--bg-app)', color: 'var(--text-main)' }}
    >
      <Sidebar />
      <main className="min-w-0 flex-1 ml-14 sm:ml-16 h-screen overflow-y-auto overflow-x-hidden relative">
        <div className={`h-full w-full pt-4 transition-all duration-300 ${compactMode ? 'text-[0.95rem]' : ''}`}>
          {children}
        </div>
      </main>
    </div>
  );
};
