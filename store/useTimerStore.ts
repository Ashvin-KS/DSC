import { create } from 'zustand';

interface TimerState {
    timeLeft: number;      // seconds remaining
    totalTime: number;     // total session time (for progress calculation)
    isActive: boolean;     // is timer running
    intervalId: number | null;

    // Pomodoro settings
    isPomodoroEnabled: boolean;
    mode: 'pomodoro' | 'shortBreak' | 'longBreak';
    autoSyncMusic: boolean;

    // Actions
    start: () => void;
    pause: () => void;
    reset: (duration?: number) => void;
    setDuration: (minutes: number) => void;
    setMode: (mode: 'pomodoro' | 'shortBreak' | 'longBreak') => void;
    togglePomodoro: () => void;
    toggleAutoSyncMusic: () => void;
}

import { useMusicStore } from './useMusicStore';
import { useNotificationStore } from './useNotificationStore';

export const useTimerStore = create<TimerState>()((set, get) => ({
    timeLeft: 25 * 60,     // 25 minutes default
    totalTime: 25 * 60,
    isActive: false,
    intervalId: null,
    isPomodoroEnabled: false,
    mode: 'pomodoro',
    autoSyncMusic: true,

    start: () => {
        // Don't start if already active or no time left
        if (get().isActive || get().timeLeft <= 0) return;

        // Ensure any existing interval is strictly cleared before starting a new one
        const existingId = get().intervalId;
        if (existingId !== null) {
            window.clearInterval(existingId);
        }
        
        // Optimistically lock state
        set({ isActive: true });

        const id = window.setInterval(() => {
            const current = get().timeLeft;
            if (current <= 1) {
                // Timer complete
                get().pause();
                set({ timeLeft: 0 });

                // Auto-sync music if enabled
                if (get().autoSyncMusic) {
                    useMusicStore.getState().pause();
                }

                useNotificationStore.getState().pushNotification({
                    type: 'success',
                    title: 'Focus timer complete',
                    message: 'Your Zen focus session finished.',
                    source: 'zen',
                });
            } else {
                set({ timeLeft: current - 1 });
            }
        }, 1000);

        set({ isActive: true, intervalId: id });
    },

    pause: () => {
        const id = get().intervalId;
        if (id) {
            window.clearInterval(id);
        }
        set({ isActive: false, intervalId: null });
    },

    reset: (duration?: number) => {
        // Stop any running interval
        const id = get().intervalId;
        if (id) {
            window.clearInterval(id);
        }

        const newDuration = duration ?? get().totalTime;
        set({
            timeLeft: newDuration,
            totalTime: newDuration,
            isActive: false,
            intervalId: null
        });
    },

    setDuration: (minutes: number) => {
        const seconds = minutes * 60;
        set({
            timeLeft: seconds,
            totalTime: seconds
        });
    },

    setMode: (mode) => {
        let minutes = 25;
        if (mode === 'shortBreak') minutes = 5;
        if (mode === 'longBreak') minutes = 15;

        set({ mode });
        get().reset(minutes * 60);
    },

    togglePomodoro: () => {
        const isEnabled = !get().isPomodoroEnabled;
        set({ isPomodoroEnabled: isEnabled });
        if (isEnabled) {
            get().setMode('pomodoro');
        }
    },

    toggleAutoSyncMusic: () => {
        set({ autoSyncMusic: !get().autoSyncMusic });
    }
}));

// Helper to format time
export const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};
