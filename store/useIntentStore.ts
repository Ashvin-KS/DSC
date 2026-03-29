import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ActivityEntry {
    id: number;
    appName: string;
    windowTitle: string;
    categoryId: number;
    startTime: number;
    endTime: number;
    durationSeconds: number;
}

export interface ActivityStats {
    totalTime: number;
    byCategory: { categoryId: number; label: string; seconds: number; color: string }[];
    topApps: { appName: string; seconds: number }[];
}

export interface ChatSession {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}

export interface ChatMessage {
    id: number;
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
}

export interface DiaryEntry {
    id: string;
    date: string;         // ISO date string 'YYYY-MM-DD'
    content: string;
    isAiGenerated: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface AppSettings {
    // API Keys
    nvidiaApiKey: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    groqApiKey?: string;
    googleClientId: string;
    googleClientSecret: string;
    // AI
    defaultModel: string;
    aiProvider?: string;
    // Tracking
    trackApps: boolean;
    trackScreenOcr: boolean;
    trackMedia: boolean;
    trackBrowser: boolean;
    excludedApps?: string[];
    // Storage
    dataRetentionDays: number;
    maxStorageMb?: number;
    autoCleanup?: boolean;
    // System
    enableStartup?: boolean;
    startupBehavior?: string;
    minimizeToTray?: boolean;
    closeToTray?: boolean;
    // Notifications
    enableNotifications?: boolean;
    enableReminders?: boolean;
    enableSummaryAlerts?: boolean;
    // Appearance
    compactMode?: boolean;
    fontScale?: number;
    colorScheme?: 'system' | 'dark' | 'light';
    // Locale
    locale?: string;
    dateFormat?: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface IntentState {
    // Activity
    activityStats: ActivityStats | null;
    activities: ActivityEntry[];
    setActivityStats: (stats: ActivityStats) => void;
    setActivities: (entries: ActivityEntry[]) => void;

    // Chat
    chatSessions: ChatSession[];
    setChatSessions: (sessions: ChatSession[]) => void;
    addChatSession: (session: ChatSession) => void;
    removeChatSession: (id: string) => void;

    // Diary
    diaryEntries: DiaryEntry[];
    setDiaryEntries: (entries: DiaryEntry[]) => void;
    addDiaryEntry: (entry: DiaryEntry) => void;
    updateDiaryEntry: (id: string, updates: Partial<DiaryEntry>) => void;

    // Settings
    settings: AppSettings | null;
    setSettings: (settings: AppSettings) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
    nvidiaApiKey: '',
    googleClientId: '',
    googleClientSecret: '',
    defaultModel: 'moonshotai/kimi-k2.5',
    aiProvider: 'nvidia',
    trackApps: true,
    trackScreenOcr: false,
    trackMedia: true,
    trackBrowser: false,
    excludedApps: [],
    dataRetentionDays: 30,
    maxStorageMb: 512,
    autoCleanup: true,
    enableStartup: true,
    startupBehavior: 'minimized_to_tray',
    minimizeToTray: true,
    closeToTray: true,
    enableNotifications: true,
    enableReminders: false,
    enableSummaryAlerts: true,
    compactMode: false,
    fontScale: 1,
    colorScheme: 'dark',
    locale: 'en-US',
    dateFormat: 'YYYY-MM-DD',
};

export const useIntentStore = create<IntentState>((set) => ({
    activityStats: null,
    activities: [],
    setActivityStats: (stats) => set({ activityStats: stats }),
    setActivities: (entries) => set({ activities: entries }),

    chatSessions: [],
    setChatSessions: (sessions) => set({ chatSessions: sessions }),
    addChatSession: (session) =>
        set((s) => ({ chatSessions: [session, ...s.chatSessions] })),
    removeChatSession: (id) =>
        set((s) => ({ chatSessions: s.chatSessions.filter((c) => c.id !== id) })),

    diaryEntries: [],
    setDiaryEntries: (entries) => set({ diaryEntries: entries }),
    addDiaryEntry: (entry) =>
        set((s) => ({ diaryEntries: [entry, ...s.diaryEntries] })),
    updateDiaryEntry: (id, updates) =>
        set((s) => ({
            diaryEntries: s.diaryEntries.map((e) =>
                e.id === id ? { ...e, ...updates, updatedAt: Date.now() / 1000 } : e
            ),
        })),

    settings: null,
    setSettings: (settings) => set({ settings }),
}));
