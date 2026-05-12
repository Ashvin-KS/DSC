import { create } from 'zustand';

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  source?: string;
  createdAt: number;
}

interface NotificationState {
  notifications: AppNotification[];
  pushNotification: (notification: Omit<AppNotification, 'id' | 'createdAt'>) => string;
  dismissNotification: (id: string) => void;
  clearNotifications: () => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  pushNotification: (notification) => {
    const id = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: AppNotification = {
      ...notification,
      id,
      createdAt: Date.now(),
    };
    set((state) => ({ notifications: [next, ...state.notifications].slice(0, 25) }));
    return id;
  },
  dismissNotification: (id) => set((state) => ({
    notifications: state.notifications.filter((notification) => notification.id !== id),
  })),
  clearNotifications: () => set({ notifications: [] }),
}));
