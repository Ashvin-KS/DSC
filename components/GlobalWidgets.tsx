import React, { useEffect, useState } from 'react';
import { MusicEngine } from './zen/MusicEngine';
import { DynamicIsland } from './DynamicIsland';
import { useNavStore } from '../store/useNavStore';
import { useNotificationStore } from '../store/useNotificationStore';

/**
 * GlobalWidgets now simply renders the headless MusicEngine
 * and the unified DynamicIsland component.
 * DynamicIsland is hidden on the Music page since MusicView has its own full player.
 */
export const GlobalWidgets: React.FC = () => {
    const [incognito, setIncognito] = useState<{ active: boolean; remainingSeconds: number }>({ active: false, remainingSeconds: 0 });
    const activeTab = useNavStore((s) => s.activeTab);
    const notifications = useNotificationStore((s) => s.notifications);
    const dismissNotification = useNotificationStore((s) => s.dismissNotification);
    const clearNotifications = useNotificationStore((s) => s.clearNotifications);

    useEffect(() => {
        const sync = async () => {
            try {
                const status = await window.atheletiaAPI?.app?.getIncognitoStatus?.();
                if (status) setIncognito(status);
            } catch {
                // ignore outside tauri
            }
        };
        const onTick = (event: Event) => {
            const detail = (event as CustomEvent<{ active: boolean; remainingSeconds: number }>).detail;
            if (detail) setIncognito(detail);
        };
        sync();
        window.addEventListener('atheletia:incognito-tick', onTick);
        return () => window.removeEventListener('atheletia:incognito-tick', onTick);
    }, []);

    useEffect(() => {
        const onClear = () => clearNotifications();
        window.addEventListener('atheletia:clear-notifications', onClear);
        return () => window.removeEventListener('atheletia:clear-notifications', onClear);
    }, [clearNotifications]);

    const label = incognito.remainingSeconds > 0
        ? `${String(Math.floor(incognito.remainingSeconds / 60)).padStart(2, '0')}:${String(Math.max(0, incognito.remainingSeconds % 60)).padStart(2, '0')}`
        : 'ON';

    return (
        <>
            {activeTab !== 'music' && <DynamicIsland />}
            <MusicEngine />
            {incognito.active && (
                <div className="fixed top-4 right-4 z-system px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-semibold">
                    Incognito {label}
                </div>
            )}
            {notifications.length > 0 && (
                <div className="fixed right-4 top-16 z-system flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
                    {notifications.slice(0, 3).map((item) => (
                        <button
                            key={item.id}
                            onClick={() => dismissNotification(item.id)}
                            className="rounded-lg border border-white/10 bg-[#101720]/95 px-3 py-2 text-left shadow-2xl backdrop-blur hover:bg-[#142033]"
                        >
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-sm font-semibold text-white">{item.title}</span>
                                <span className="text-[10px] uppercase text-gray-500">{item.source || item.type}</span>
                            </div>
                            {item.message && <div className="mt-1 text-xs text-gray-400">{item.message}</div>}
                        </button>
                    ))}
                </div>
            )}
        </>
    );
};
