import React, { useEffect, useState } from 'react';
import { MusicEngine } from './zen/MusicEngine';
import { DynamicIsland } from './DynamicIsland';
import { useNavStore } from '../store/useNavStore';

/**
 * GlobalWidgets now simply renders the headless MusicEngine
 * and the unified DynamicIsland component.
 * DynamicIsland is hidden on the Music page since MusicView has its own full player.
 */
export const GlobalWidgets: React.FC = () => {
    const [incognito, setIncognito] = useState<{ active: boolean; remainingSeconds: number }>({ active: false, remainingSeconds: 0 });
    const activeTab = useNavStore((s) => s.activeTab);

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
        </>
    );
};
