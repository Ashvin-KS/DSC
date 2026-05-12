import React, { useState, useEffect, useCallback } from 'react';
import {
    ArrowRight, ArrowLeft, CheckCircle2, Palette, Brain, Activity,
    BookOpen, Music, Calendar, Timer, X, Sparkles, Zap, Eye, ShieldCheck, Dumbbell
} from 'lucide-react';
import { useIntentStore, type AppSettings } from '../store/useIntentStore';
import { useNavStore } from '../store/useNavStore';
import { applyThemePreset, THEME_PRESETS, type ThemePresetId } from '../lib/theme';

const ONBOARDED_KEY = 'atheletia_onboarded';

// ─── Providers ───────────────────────────────────────────────────────────────
type AiProviderId = 'nvidia' | 'openai' | 'anthropic' | 'groq' | 'gemini';
type AiProvider = {
    id: AiProviderId;
    name: string;
    settingsKey: keyof Pick<AppSettings, 'nvidiaApiKey' | 'openaiApiKey' | 'anthropicApiKey' | 'groqApiKey' | 'geminiApiKey'>;
    placeholder: string;
    note: string;
    recommended?: boolean;
};

const AI_PROVIDERS: readonly AiProvider[] = [
    { id: 'nvidia', name: 'NVIDIA NIM', settingsKey: 'nvidiaApiKey', placeholder: 'nvapi-...', note: 'Free tier available', recommended: true },
    { id: 'openai', name: 'OpenAI', settingsKey: 'openaiApiKey', placeholder: 'sk-...', note: 'GPT-4o, GPT-4 models' },
    { id: 'anthropic', name: 'Anthropic', settingsKey: 'anthropicApiKey', placeholder: 'sk-ant-...', note: 'Claude models' },
    { id: 'groq', name: 'Groq', settingsKey: 'groqApiKey', placeholder: 'gsk_...', note: 'Very fast, free tier' },
    { id: 'gemini', name: 'Google Gemini', settingsKey: 'geminiApiKey', placeholder: 'AIza...', note: 'Gemini 2.0 Flash' },
] as const;

// ─── Theme previews ──────────────────────────────────────────────────────────
type ThemePreview = { id: ThemePresetId; name: string; bg: string; accent: string; border: string };

const THEME_PREVIEWS: readonly ThemePreview[] = [
    { id: 'dark-2026', name: 'Dark 2026', bg: '#101720', accent: '#5a9aff', border: '#233245' },
    { id: 'monokai', name: 'Monokai', bg: '#272822', accent: '#f92672', border: '#3a3c32' },
    { id: 'abyss', name: 'Abyss', bg: '#001122', accent: '#00b5d8', border: '#0d2943' },
    { id: 'vs-dark', name: 'VS Dark', bg: '#252526', accent: '#007acc', border: '#313135' },
    { id: 'kimbie-dark', name: 'Kimbie', bg: '#221f1e', accent: '#f8b96d', border: '#362f2a' },
    { id: 'tomorrow-night-blue', name: 'Tomorrow Night', bg: '#002451', accent: '#ff9d4d', border: '#173767' },
    { id: 'light-2026', name: 'Light 2026', bg: '#ffffff', accent: '#2a6bff', border: '#d7dde8' },
    { id: 'light-modern', name: 'Light Modern', bg: '#fcfdff', accent: '#0f8b8d', border: '#d4dde9' },
    { id: 'solarized-light', name: 'Solarized Light', bg: '#fdf6e3', accent: '#268bd2', border: '#d6cfbb' },
];

interface OnboardingProps {
    onComplete: () => void;
}

const OnboardingModal: React.FC<OnboardingProps> = ({ onComplete }) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [isAnimating, setIsAnimating] = useState(false);

    // Real settings integration
    const { settings, setSettings } = useIntentStore();
    const setActiveTab = useNavStore(s => s.setActiveTab);

    // API key step state
    const [selectedProvider, setSelectedProvider] = useState<AiProviderId>('nvidia');
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [apiKeySaved, setApiKeySaved] = useState(false);

    // Theme step state
    const [selectedTheme, setSelectedTheme] = useState<ThemePresetId>((settings?.themePreset || 'dark-2026') as ThemePresetId);

    // Privacy step state (seeded from current settings)
    const [trackApps, setTrackApps] = useState(settings?.trackApps ?? true);
    const [trackScreenOcr, setTrackScreenOcr] = useState(settings?.trackScreenOcr ?? false);
    const [trackMedia, setTrackMedia] = useState(settings?.trackMedia ?? true);
    const [trackBrowser, setTrackBrowser] = useState(settings?.trackBrowser ?? false);
    const [autoCreateDiary, setAutoCreateDiary] = useState((settings as any)?.autoCreateDiary ?? true);

    const totalSteps = 6; // welcome, api, theme, privacy, overview, ready
    const isLast = currentStep === totalSteps - 1;
    const isFirst = currentStep === 0;

    // Apply theme when selected
    const handleThemeSelect = useCallback((themeId: ThemePresetId) => {
        setSelectedTheme(themeId);
        // Actually apply the theme live
        if (THEME_PRESETS[themeId]) {
            applyThemePreset(themeId);
            if (settings) {
                const updated: AppSettings = { ...settings, themePreset: themeId };
                setSettings(updated);
                try { window.atheletiaAPI?.settings?.save?.(updated); } catch { /* ok */ }
            }
        }
    }, [settings, setSettings]);

    // Save API key
    const handleSaveApiKey = useCallback(() => {
        if (!apiKeyInput.trim()) return;
        const provider = AI_PROVIDERS.find(p => p.id === selectedProvider);
        if (!provider || !settings) return;

        const updated: AppSettings = {
            ...settings,
            [provider.settingsKey]: apiKeyInput.trim(),
        };
        setSettings(updated);
        try { window.atheletiaAPI?.settings?.save?.(updated); } catch { /* ok */ }
        setApiKeySaved(true);
        setTimeout(() => setApiKeySaved(false), 3000);
    }, [apiKeyInput, selectedProvider, settings, setSettings]);

    const navigate = (direction: 'next' | 'prev') => {
        if (isAnimating) return;
        setIsAnimating(true);
        setTimeout(() => {
            setCurrentStep(p => direction === 'next' ? p + 1 : p - 1);
            setIsAnimating(false);
        }, 200);
    };

    const handleComplete = () => {
        localStorage.setItem(ONBOARDED_KEY, '1');
        onComplete();
    };

    const handleCompleteAndGoToSettings = () => {
        localStorage.setItem(ONBOARDED_KEY, '1');
        setActiveTab('settings');
        onComplete();
    };

    // ─── Step renderers ──────────────────────────────────────────────────────
    const renderWelcome = () => (
        <div className="space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">
                Atheletia is a desktop companion that tracks your daily life — your apps, music,
                coding, schedule, and more — then uses AI to reflect it back as a personal diary and insights.
            </p>
            <div className="grid grid-cols-2 gap-3">
                {[
                    { icon: Activity, label: 'Activity Tracking', color: 'text-cyan-400' },
                    { icon: BookOpen, label: 'Smart Diary', color: 'text-purple-400' },
                    { icon: Brain, label: 'AI Insights', color: 'text-pink-400' },
                    { icon: Music, label: 'Music Player', color: 'text-green-400' },
                    { icon: Calendar, label: 'Schedule', color: 'text-orange-400' },
                    { icon: Timer, label: 'Focus Timer', color: 'text-indigo-400' },
                    { icon: Dumbbell, label: 'Workout', color: 'text-emerald-400' },
                ].map(({ icon: Icon, label, color }) => (
                    <div key={label} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.07]">
                        <Icon size={14} className={color} />
                        <span className="text-xs text-gray-300 font-medium">{label}</span>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderApiSetup = () => {
        const currentProvider = AI_PROVIDERS.find(p => p.id === selectedProvider)!;
        return (
            <div className="space-y-4">
                <p className="text-sm text-gray-300 leading-relaxed">
                    Add an API key for any provider you want to use. Atheletia routes requests by the selected model.
                </p>
                {/* API key target */}
                <div className="space-y-1.5">
                    {AI_PROVIDERS.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => { setSelectedProvider(p.id); setApiKeySaved(false); }}
                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all ${
                                selectedProvider === p.id
                                    ? 'border-accent/40 bg-[var(--accent-soft)]'
                                    : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
                            }`}
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-white">{p.name}</span>
                                {p.recommended && <span className="text-[8px] font-bold text-accent bg-accent/20 px-1.5 py-0.5 rounded-full uppercase tracking-wider">Recommended</span>}
                            </div>
                            <span className="text-[10px] text-gray-600">{p.note}</span>
                        </button>
                    ))}
                </div>
                {/* API key input */}
                <div className="space-y-2">
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={apiKeyInput}
                            onChange={(e) => { setApiKeyInput(e.target.value); setApiKeySaved(false); }}
                            placeholder={currentProvider.placeholder}
                            className="flex-1 px-3 py-2.5 bg-[#111] border border-white/10 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent/40"
                        />
                        <button
                            onClick={handleSaveApiKey}
                            disabled={!apiKeyInput.trim() || apiKeySaved}
                            className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                                apiKeySaved
                                    ? 'bg-green-500/20 border border-green-500/30 text-green-400'
                                    : 'bg-accent text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-30'
                            }`}
                        >
                            {apiKeySaved ? '✓ Saved' : 'Save'}
                        </button>
                    </div>
                    <p className="text-[10px] text-gray-600">Your key is stored locally and never shared.</p>
                </div>
                <div className="flex items-start gap-2 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                    <Zap size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-yellow-200">Skip this step and add it later in <strong>Settings → API Keys</strong>.</p>
                </div>
            </div>
        );
    };

    const renderThemeSetup = () => (
        <div className="space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">
                Click a theme to apply it <strong className="text-white">live</strong>. The change is instant and persistent.
            </p>
            <div className="grid grid-cols-3 gap-2">
                {THEME_PREVIEWS.map(({ id, name, bg, accent, border }) => (
                    <button
                        key={id}
                        onClick={() => handleThemeSelect(id)}
                        className={`rounded-xl overflow-hidden border cursor-pointer transition-all ${
                            selectedTheme === id ? 'ring-2 ring-accent scale-[1.03]' : 'hover:scale-105'
                        }`}
                        style={{ background: bg, borderColor: selectedTheme === id ? accent : border }}
                    >
                        <div className="p-2">
                            <div className="h-3 rounded-full mb-1.5" style={{ background: accent, width: '60%' }} />
                            <div className="h-1.5 rounded-full mb-1" style={{ background: border, width: '90%' }} />
                            <div className="h-1.5 rounded-full" style={{ background: border, width: '70%' }} />
                        </div>
                        <div className="px-2 pb-2 flex items-center justify-between">
                            <span className="text-[9px] font-semibold" style={{ color: accent }}>{name}</span>
                            {selectedTheme === id && <CheckCircle2 size={10} style={{ color: accent }} />}
                        </div>
                    </button>
                ))}
            </div>
            <p className="text-[10px] text-gray-600 text-center">17 themes available total — explore more in Settings → Appearance.</p>
        </div>
    );

    const renderOverview = () => (
        <div className="space-y-2">
            {[
                { icon: Activity, color: 'text-cyan-400', bg: 'bg-cyan-400/10', name: 'Dashboard', desc: 'AI summary of your day — apps, productivity, and habits at a glance.' },
                { icon: Activity, color: 'text-orange-400', bg: 'bg-orange-400/10', name: 'Activity', desc: 'Detailed timeline of your app usage, focus time, and active hours.' },
                { icon: BookOpen, color: 'text-purple-400', bg: 'bg-purple-400/10', name: 'Diary', desc: 'AI-generated daily reflections + your personal notes. Per-day, always isolated.' },
                { icon: Brain, color: 'text-pink-400', bg: 'bg-pink-400/10', name: 'Brain', desc: 'Your personal knowledge vault — notes, markdown, files, and AI memory.' },
                { icon: Zap, color: 'text-yellow-400', bg: 'bg-yellow-400/10', name: 'LeetCode', desc: 'Track your problem-solving progress.' },
                { icon: Calendar, color: 'text-green-400', bg: 'bg-green-400/10', name: 'Schedule', desc: 'Google Calendar integration + task management.' },
                { icon: Timer, color: 'text-indigo-400', bg: 'bg-indigo-400/10', name: 'Zen / Focus', desc: 'Pomodoro timer with music sync.' },
                { icon: Music, color: 'text-green-300', bg: 'bg-green-300/10', name: 'Music', desc: 'Built-in YouTube Music player.' },
                { icon: Dumbbell, color: 'text-emerald-300', bg: 'bg-emerald-300/10', name: 'Workout', desc: 'Editable weekly routines, AI workout helper, and exercise tutorials.' },
            ].map(({ icon: Icon, color, bg, name, desc }) => (
                <div key={name} className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                    <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                        <Icon size={14} className={color} />
                    </div>
                    <div>
                        <p className="text-sm font-semibold text-white">{name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderPrivacy = () => {
        const toggleItems = [
            { label: 'App & Window Tracking', desc: 'Track which apps and windows you use.', checked: trackApps, onChange: setTrackApps, settingsKey: 'trackApps' },
            { label: 'Screen OCR', desc: 'Read text from screen snapshots for richer AI context.', checked: trackScreenOcr, onChange: setTrackScreenOcr, settingsKey: 'trackScreenOcr' },
            { label: 'Media Tracking', desc: 'Track media playback context (music, videos).', checked: trackMedia, onChange: setTrackMedia, settingsKey: 'trackMedia' },
            { label: 'Browser Tracking', desc: 'Track browser title/URL metadata.', checked: trackBrowser, onChange: setTrackBrowser, settingsKey: 'trackBrowser' },
            { label: 'Auto-Create Diary', desc: 'At 8 PM, auto-generate today\'s AI diary entry.', checked: autoCreateDiary, onChange: setAutoCreateDiary, settingsKey: 'autoCreateDiary' },
        ];

        const handleToggle = (item: typeof toggleItems[0], val: boolean) => {
            item.onChange(val);
            if (settings) {
                const updated = { ...settings, [item.settingsKey]: val };
                setSettings(updated as any);
                try { window.atheletiaAPI?.settings?.save?.(updated as any); } catch { /* ok */ }
            }
        };

        return (
            <div className="space-y-3">
                <p className="text-sm text-gray-300 leading-relaxed">
                    Control what Atheletia monitors. All data stays <strong className="text-white">local on your machine</strong>.
                </p>
                <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] divide-y divide-white/[0.06]">
                    {toggleItems.map((item) => (
                        <div key={item.settingsKey} className="flex items-center justify-between px-4 py-3">
                            <div>
                                <p className="text-sm font-medium text-gray-200">{item.label}</p>
                                <p className="text-[11px] text-gray-500 mt-0.5">{item.desc}</p>
                            </div>
                            <button
                                onClick={() => handleToggle(item, !item.checked)}
                                className={`relative w-10 h-[22px] rounded-full transition-colors ${item.checked ? 'bg-accent' : 'bg-white/10'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white transition-transform ${item.checked ? 'translate-x-4' : ''}`} />
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                    <ShieldCheck size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-blue-200">All data is stored locally. Nothing is sent to any server unless you explicitly use an AI API.</p>
                </div>
            </div>
        );
    };

    const renderReady = () => (
        <div className="space-y-5">
            <p className="text-sm text-gray-300 leading-relaxed">
                You're all set! Here's what happens next:
            </p>
            <div className="space-y-2">
                {[
                    apiKeySaved ? '✅ API key saved — AI features are ready' : '⚠️ No API key yet — add one in Settings → API Keys',
                    `🎨 Theme: ${THEME_PREVIEWS.find(t => t.id === selectedTheme)?.name || selectedTheme}`,
                    trackApps ? '📊 App tracking enabled' : '📊 App tracking disabled',
                    trackScreenOcr ? '🔍 Screen OCR enabled — richer AI context' : '🔍 Screen OCR disabled',
                    autoCreateDiary ? '📖 Diary auto-generates at 8 PM for today' : '📖 Diary auto-create disabled',
                    '🎵 Open Music tab to search and play songs',
                ].map((text) => (
                    <div key={text} className="flex items-center gap-2 text-sm text-gray-300">
                        <span>{text}</span>
                    </div>
                ))}
            </div>
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-[var(--accent-soft)] border border-accent/20">
                <Sparkles size={20} className="text-accent flex-shrink-0" />
                <p className="text-sm text-white font-medium">
                    Check the Dashboard tomorrow for your first AI summary!
                </p>
            </div>
        </div>
    );

    const stepData = [
        { emoji: '✨', title: 'Welcome to Atheletia', subtitle: 'Your AI-powered personal productivity dashboard', render: renderWelcome },
        { emoji: '🔑', title: 'Set Up Your AI Key', subtitle: 'Connect an AI provider (you can skip this)', render: renderApiSetup },
        { emoji: '🎨', title: 'Choose Your Theme', subtitle: 'Click to apply live — change anytime', render: renderThemeSetup },
        { emoji: '🛡️', title: 'Privacy & Tracking', subtitle: 'Choose what Atheletia monitors', render: renderPrivacy },
        { emoji: '🗺️', title: 'App Overview', subtitle: 'What each section does', render: renderOverview },
        { emoji: '🚀', title: "You're All Set!", subtitle: "Atheletia is ready. Let's get started.", render: renderReady },
    ];

    const step = stepData[currentStep];

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/80 backdrop-blur-xl" />

            {/* Modal */}
            <div className="relative w-full max-w-lg mx-4 bg-[#0e1118] border border-white/[0.08] rounded-3xl shadow-[0_32px_80px_rgba(0,0,0,0.6)] overflow-hidden">
                {/* Top gradient bar */}
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent" />

                {/* Skip button */}
                <button
                    onClick={handleComplete}
                    className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors z-10"
                >
                    <X size={16} />
                </button>

                <div className={`transition-opacity duration-200 ${isAnimating ? 'opacity-0' : 'opacity-100'}`}>
                    {/* Header */}
                    <div className="px-8 pt-8 pb-4 text-center">
                        <div className="text-5xl mb-3">{step.emoji}</div>
                        <h2 className="text-xl font-bold text-white mb-1">{step.title}</h2>
                        <p className="text-sm text-gray-500">{step.subtitle}</p>
                    </div>

                    {/* Content */}
                    <div className="px-8 pb-4 max-h-[48vh] overflow-y-auto">
                        {step.render()}
                    </div>

                    {/* Progress + Navigation */}
                    <div className="px-8 pb-8">
                        {/* Step dots */}
                        <div className="flex justify-center gap-1.5 mb-5">
                            {stepData.map((_, i) => (
                                <div
                                    key={i}
                                    className={`rounded-full transition-all duration-300 ${
                                        i === currentStep
                                            ? 'w-6 h-1.5 bg-accent'
                                            : i < currentStep
                                            ? 'w-1.5 h-1.5 bg-accent/40'
                                            : 'w-1.5 h-1.5 bg-white/10'
                                    }`}
                                />
                            ))}
                        </div>

                        {/* Buttons */}
                        <div className="flex items-center gap-3">
                            {!isFirst && (
                                <button
                                    onClick={() => navigate('prev')}
                                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:text-white text-sm font-medium transition-colors"
                                >
                                    <ArrowLeft size={16} />
                                    Back
                                </button>
                            )}
                            {isLast ? (
                                <div className="flex-1 flex gap-2">
                                    <button
                                        onClick={handleCompleteAndGoToSettings}
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:text-white text-sm font-medium transition-colors"
                                    >
                                        <Eye size={16} />
                                        Open Settings
                                    </button>
                                    <button
                                        onClick={handleComplete}
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent text-[var(--accent-contrast)] hover:opacity-90 text-sm font-semibold transition-all shadow-lg shadow-accent/20"
                                    >
                                        <CheckCircle2 size={16} />
                                        Get Started
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => navigate('next')}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent text-[var(--accent-contrast)] hover:opacity-90 text-sm font-semibold transition-all shadow-lg shadow-accent/20"
                                >
                                    Next
                                    <ArrowRight size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

/**
 * Hook to manage onboarding state.
 * Returns {showOnboarding, completeOnboarding}.
 */
export function useOnboarding() {
    const [showOnboarding, setShowOnboarding] = useState(false);

    useEffect(() => {
        const done = localStorage.getItem(ONBOARDED_KEY);
        if (!done) {
            // Slight delay so the app loads first
            const timer = setTimeout(() => setShowOnboarding(true), 800);
            return () => clearTimeout(timer);
        }
    }, []);

    const completeOnboarding = () => setShowOnboarding(false);

    return { showOnboarding, completeOnboarding };
}

export const Onboarding: React.FC = () => {
    const { showOnboarding, completeOnboarding } = useOnboarding();

    if (!showOnboarding) return null;

    return <OnboardingModal onComplete={completeOnboarding} />;
};
