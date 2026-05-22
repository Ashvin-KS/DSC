import { create } from 'zustand';
import type { ThemePresetId } from '../lib/theme';

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

// Import and re-export canonical types from lib/chatTypes to avoid duplication
import type { ChatSession, ChatMessage } from '../lib/chatTypes';
export type { ChatSession, ChatMessage };


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
    geminiApiKey?: string;
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
    themePreset?: ThemePresetId;
    // Locale
    locale?: string;
    dateFormat?: string;
    // Diary
    autoCreateDiary?: boolean;
    // Profile
    profileName?: string;
    profileRole?: string;
    profileColor?: string;
    profileBio?: string;
    profileTone?: 'Analytical' | 'Supportive' | 'Concise' | 'Empathetic' | 'Direct';
    profileStyle?: 'Technical & Detailed' | 'Conversational & Casual' | 'Action-Oriented' | 'Simple & Direct';
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

    // Onboarding UI State
    showOnboarding: boolean;
    setShowOnboarding: (show: boolean) => void;
    onboardingStep: number;
    setOnboardingStep: (step: number | ((prev: number) => number)) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
    nvidiaApiKey: '',
    googleClientId: '',
    googleClientSecret: '',
    defaultModel: 'meta/llama-3.3-70b-instruct',
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
    themePreset: 'dark-2026',
    locale: 'en-US',
    dateFormat: 'YYYY-MM-DD',
    autoCreateDiary: false,
    profileName: '',
    profileRole: '',
    profileColor: '#6366f1',
    profileBio: '',
    profileTone: 'Concise',
    profileStyle: 'Simple & Direct',
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

    settings: DEFAULT_SETTINGS,
    setSettings: (settings) => set({ settings }),

    showOnboarding: false,
    setShowOnboarding: (show) => set({ showOnboarding: show }),
    onboardingStep: 0,
    setOnboardingStep: (step) =>
        set((s) => ({
            onboardingStep:
                typeof step === 'function'
                    ? (step as (prev: number) => number)(s.onboardingStep)
                    : step,
        })),
}));
