import { create } from 'zustand';

const NOTIFICATION_AUTO_DISMISS_MS = 5000;
const notificationTimers = new Map<string, number>();

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

const clearNotificationTimer = (id: string) => {
  const timer = notificationTimers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    notificationTimers.delete(id);
  }
};

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  pushNotification: (notification) => {
    const id = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: AppNotification = {
      ...notification,
      id,
      createdAt: Date.now(),
    };
    set((state) => ({ notifications: [next, ...state.notifications].slice(0, 25) }));
    const timer = window.setTimeout(() => {
      get().dismissNotification(id);
    }, NOTIFICATION_AUTO_DISMISS_MS);
    notificationTimers.set(id, timer);
    return id;
  },
  dismissNotification: (id) => {
    clearNotificationTimer(id);
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    }));
  },
  clearNotifications: () => {
    notificationTimers.forEach((timer) => window.clearTimeout(timer));
    notificationTimers.clear();
    set({ notifications: [] });
  },
}));
