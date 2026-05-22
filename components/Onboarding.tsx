import React, { useState, useEffect, useCallback } from 'react';
import {
    ArrowRight, ArrowLeft, CheckCircle2, Palette, Brain, Activity,
    BookOpen, Music, Calendar, Timer, X, Sparkles, Zap, Eye, ShieldCheck, Dumbbell,
    User, Info, MessageSquare, Terminal, ChevronRight
} from 'lucide-react';
import { useIntentStore, type AppSettings } from '../store/useIntentStore';
import { useNavStore } from '../store/useNavStore';
import { applyThemePreset, THEME_PRESETS, type ThemePresetId } from '../lib/theme';

const ONBOARDED_KEY = 'atheletia_onboarded';

const getInitials = (name: string) => {
    const parts = (name || '').trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) return '?';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// ─── Providers ───────────────────────────────────────────────────────────────
type AiProviderId = 'nvidia' | 'openai' | 'anthropic' | 'groq' | 'gemini';
type AiProvider = {
    id: AiProviderId;
    name: string;
    settingsKey: keyof Pick<AppSettings, 'nvidiaApiKey' | 'openaiApiKey' | 'anthropicApiKey' | 'groqApiKey' | 'geminiApiKey'>;
    placeholder: string;
    note?: string;
    recommended?: boolean;
};

const AI_PROVIDERS: readonly AiProvider[] = [
    { id: 'nvidia', name: 'NVIDIA NIM', settingsKey: 'nvidiaApiKey', placeholder: 'nvapi-...' },
    { id: 'openai', name: 'OpenAI', settingsKey: 'openaiApiKey', placeholder: 'sk-...' },
    { id: 'anthropic', name: 'Anthropic', settingsKey: 'anthropicApiKey', placeholder: 'sk-ant-...' },
    { id: 'groq', name: 'Groq', settingsKey: 'groqApiKey', placeholder: 'gsk_...' },
    { id: 'gemini', name: 'Google Gemini', settingsKey: 'geminiApiKey', placeholder: 'AIza...' },
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

const TONES: { id: AppSettings['profileTone']; label: string; desc: string }[] = [
    { id: 'Analytical', label: 'Analytical', desc: 'Detailed reasoning, data-focused, logic-driven.' },
    { id: 'Supportive', label: 'Supportive', desc: 'Encouraging, coaching-oriented, warm.' },
    { id: 'Concise', label: 'Concise', desc: 'Short, clean, to-the-point summaries.' },
    { id: 'Empathetic', label: 'Empathetic', desc: 'Understanding, reflective of your mood.' },
    { id: 'Direct', label: 'Direct', desc: 'Blunt, actionable insights, highly efficient.' }
];

const STYLES: { id: AppSettings['profileStyle']; label: string; desc: string }[] = [
    { id: 'Technical & Detailed', label: 'Technical & Detailed', desc: 'Includes technical concepts, deep lists.' },
    { id: 'Conversational & Casual', label: 'Conversational & Casual', desc: 'Like chatting with a clever friend.' },
    { id: 'Action-Oriented', label: 'Action-Oriented', desc: 'Highlights tasks, next steps, productivity.' },
    { id: 'Simple & Direct', label: 'Simple & Direct', desc: 'Plain language, minimal styling, easy reading.' }
];

interface OnboardingProps {
    onComplete: () => void;
}

const OnboardingModal: React.FC<OnboardingProps> = ({ onComplete }) => {
    const currentStep = useIntentStore(s => s.onboardingStep);
    const setCurrentStep = useIntentStore(s => s.setOnboardingStep);
    const [isAnimating, setIsAnimating] = useState(false);

    // Check if we are running in dedicated Profile Editor Mode
    const isProfileOnly = localStorage.getItem(ONBOARDED_KEY) === '1';

    // Real settings integration
    const { settings, setSettings } = useIntentStore();
    const setActiveTab = useNavStore(s => s.setActiveTab);

    // Profile step state
    const [profileName, setProfileName] = useState(settings?.profileName || '');
    const [profileRole, setProfileRole] = useState(settings?.profileRole || '');
    const [profileColor, setProfileColor] = useState(settings?.profileColor || '#6366f1');
    const [profileBio, setProfileBio] = useState(settings?.profileBio || '');
    const [profileTone, setProfileTone] = useState<AppSettings['profileTone']>(settings?.profileTone || 'Concise');
    const [profileStyle, setProfileStyle] = useState<AppSettings['profileStyle']>(settings?.profileStyle || 'Simple & Direct');

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
    const [autoCreateDiary, setAutoCreateDiary] = useState((settings as any)?.autoCreateDiary ?? false);

    // Async settings loading and initialization
    const initializedRef = React.useRef(false);
    useEffect(() => {
        if (settings && !initializedRef.current) {
            setProfileName(settings.profileName || '');
            setProfileRole(settings.profileRole || '');
            setProfileColor(settings.profileColor || '#6366f1');
            setProfileBio(settings.profileBio || '');
            setProfileTone(settings.profileTone || 'Concise');
            setProfileStyle(settings.profileStyle || 'Simple & Direct');
            setSelectedTheme((settings.themePreset || 'dark-2026') as ThemePresetId);
            setTrackApps(settings.trackApps ?? true);
            setTrackScreenOcr(settings.trackScreenOcr ?? false);
            setTrackMedia(settings.trackMedia ?? true);
            setTrackBrowser(settings.trackBrowser ?? false);
            setAutoCreateDiary((settings as any).autoCreateDiary ?? false);
            initializedRef.current = true;
        }
    }, [settings]);

    const totalSteps = 7; // welcome, profile, api, theme, privacy, overview, ready
    const isLast = currentStep === totalSteps - 1;
    const isFirst = currentStep === 0;

    // Apply theme when selected
    const handleThemeSelect = useCallback((themeId: ThemePresetId) => {
        setSelectedTheme(themeId);
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

    const persistChanges = (key: keyof AppSettings, val: any) => {
        if (settings) {
            const updated = { ...settings, [key]: val };
            setSettings(updated);
            try { window.atheletiaAPI?.settings?.save?.(updated); } catch { /* ok */ }
        }
    };

    const handleNameChange = (val: string) => {
        setProfileName(val);
        persistChanges('profileName', val);
    };

    const handleRoleChange = (val: string) => {
        setProfileRole(val);
        persistChanges('profileRole', val);
    };

    const handleColorChange = (val: string) => {
        setProfileColor(val);
        persistChanges('profileColor', val);
    };

    const handleBioChange = (val: string) => {
        setProfileBio(val);
        persistChanges('profileBio', val);
    };

    const handleToneChange = (val: AppSettings['profileTone']) => {
        setProfileTone(val);
        persistChanges('profileTone', val);
    };

    const handleStyleChange = (val: AppSettings['profileStyle']) => {
        setProfileStyle(val);
        persistChanges('profileStyle', val);
    };

    // ─── Step renderers ──────────────────────────────────────────────────────
    const renderWelcome = () => (
        <div className="space-y-6">
            <p className="text-base text-gray-300 leading-relaxed">
                Atheletia is a highly unified desktop companion that organizes your daily life — your tasks, coding, apps, focus blocks, and workouts — then utilizes clean local context to synthesise structured summaries and reflections.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                    { icon: Activity, label: 'Activity Tracking', desc: 'App usage timelines and stats.', color: 'text-cyan-400', bg: 'bg-cyan-400/5' },
                    { icon: BookOpen, label: 'Smart Diary & Reflections', desc: 'Isolated personal notes & AI daily summaries.', color: 'text-purple-400', bg: 'bg-purple-400/5' },
                    { icon: Brain, label: 'Knowledge Brain', desc: 'Markdown files, documents, and AI memory.', color: 'text-pink-400', bg: 'bg-pink-400/5' },
                    { icon: Dumbbell, label: 'Workout Planner', desc: 'Custom routines, timer, and form guides.', color: 'text-emerald-400', bg: 'bg-emerald-400/5' },
                    { icon: Calendar, label: 'Schedules & Standups', desc: 'Calendar logs and checklist items.', color: 'text-orange-400', bg: 'bg-orange-400/5' },
                    { icon: Timer, label: 'Focus & Zen Pomodoro', desc: 'Focused sessions synced with music player.', color: 'text-indigo-400', bg: 'bg-indigo-400/5' },
                ].map(({ icon: Icon, label, desc, color, bg }) => (
                    <div key={label} className={`flex gap-3 p-3.5 rounded-2xl bg-white/[0.02] border border-white/[0.05] transition-all hover:bg-white/[0.04]`}>
                        <div className={`w-8 h-8 rounded-xl ${bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                            <Icon size={16} className={color} />
                        </div>
                        <div>
                            <span className="text-sm text-gray-200 font-semibold block">{label}</span>
                            <span className="text-xs text-gray-500 mt-0.5 block">{desc}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderProfile = () => {
        const initials = getInitials(profileName);
        const presetColors = [
            '#6366f1', // Indigo
            '#8b5cf6', // Violet
            '#10b981', // Emerald
            '#f43f5e', // Rose
            '#f59e0b', // Amber
            '#06b6d4', // Cyan
            '#d946ef', // Fuchsia
            '#f97316', // Orange
        ];

        return (
            <div className="space-y-6">
                {!isProfileOnly && (
                    <p className="text-sm text-gray-400 leading-relaxed">
                        Configure your identity. The AI will refer to your background, roles, and chosen styling constraints to tailor its advice.
                    </p>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    {/* Left Column - Core Info */}
                    <div className="lg:col-span-5 space-y-5">
                        <div className="flex flex-col items-center p-6 rounded-2xl bg-white/[0.01] border border-white/[0.04] text-center relative overflow-hidden">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-500/20 to-purple-500/20" />
                            {/* Avatar Preview */}
                            <div 
                                className="w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl font-bold font-mono transition-all duration-300 shadow-[0_10px_30px_rgba(0,0,0,0.4)] border-2 border-white/10 mb-4"
                                style={{ backgroundColor: profileColor }}
                            >
                                {initials}
                            </div>

                            <div className="w-full space-y-3.5">
                                {/* Name Input */}
                                <div className="text-left space-y-1.5">
                                    <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Your Name</label>
                                    <input
                                        type="text"
                                        value={profileName}
                                        onChange={(e) => handleNameChange(e.target.value)}
                                        placeholder="e.g. Alex Carter"
                                        className="w-full px-3 py-2 bg-white/[0.02] border border-white/[0.07] rounded-xl text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 transition-all"
                                    />
                                </div>

                                {/* Role Input */}
                                <div className="text-left space-y-1.5">
                                    <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Role / Profession</label>
                                    <input
                                        type="text"
                                        value={profileRole}
                                        onChange={(e) => handleRoleChange(e.target.value)}
                                        placeholder="e.g. Software Engineer"
                                        className="w-full px-3 py-2 bg-white/[0.02] border border-white/[0.07] rounded-xl text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 transition-all"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Color Swatches */}
                        <div className="space-y-2 p-4 rounded-xl bg-white/[0.01] border border-white/[0.04]">
                            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block">Accent Color</label>
                            <div className="flex items-center flex-wrap gap-2">
                                {presetColors.map((color) => (
                                    <button
                                        key={color}
                                        onClick={() => handleColorChange(color)}
                                        className={`w-7 h-7 rounded-full border transition-all duration-200 cursor-pointer ${
                                            profileColor === color 
                                                ? 'ring-2 ring-white scale-110 border-white shadow-[0_0_10px_var(--accent)]' 
                                                : 'border-transparent hover:scale-105'
                                        }`}
                                        style={{ backgroundColor: color }}
                                    />
                                ))}
                                
                                {/* Custom Color Input Wrapper */}
                                <div className="relative w-7 h-7 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center cursor-pointer overflow-hidden transition-transform hover:scale-105">
                                    <Palette size={13} className="text-gray-400 pointer-events-none" />
                                    <input
                                        type="color"
                                        value={profileColor}
                                        onChange={(e) => handleColorChange(e.target.value)}
                                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Column - Deep Personalization */}
                    <div className="lg:col-span-7 space-y-4">
                        {/* Bio / Persona input */}
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">AI Memory / Bio & Preferences</label>
                                <span className="text-[9px] text-gray-600 font-medium">Chat instructions will leverage this context</span>
                            </div>
                            <textarea
                                value={profileBio}
                                onChange={(e) => handleBioChange(e.target.value)}
                                placeholder="Describe your coding preferences, primary tech stack, goals, or health context (e.g. 'I am a backend programmer building Tauri apps with Rust. I prefer detailed code block examples. Suffer from light wrist pain, so suggest breaks.')"
                                className="w-full h-[88px] min-h-[88px] px-3.5 py-2.5 bg-white/[0.02] border border-white/[0.07] rounded-xl text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 transition-all resize-none"
                            />
                        </div>

                        {/* Tone Selector */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block">Preferred AI Response Tone</label>
                            <div className="grid grid-cols-2 xs:grid-cols-5 lg:grid-cols-5 gap-1.5">
                                {TONES.map((t) => {
                                    const selected = profileTone === t.id;
                                    return (
                                        <button
                                            key={t.id}
                                            onClick={() => handleToneChange(t.id)}
                                            className={`px-2 py-2 rounded-xl text-xs font-semibold border transition-all text-center flex flex-col items-center justify-center cursor-pointer ${
                                                selected
                                                    ? 'border-accent/40 bg-accent/15 text-white'
                                                    : 'border-white/[0.05] bg-white/[0.01] text-gray-500 hover:border-white/10 hover:text-gray-300'
                                            }`}
                                            title={t.desc}
                                        >
                                            <span className="block truncate w-full">{t.label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Reading Style Selector */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block">Preferred Reading & Writing Style</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {STYLES.map((s) => {
                                    const selected = profileStyle === s.id;
                                    return (
                                        <button
                                            key={s.id}
                                            onClick={() => handleStyleChange(s.id)}
                                            className={`p-3 rounded-xl border text-left transition-all flex flex-col justify-between h-14 cursor-pointer ${
                                                selected
                                                    ? 'border-accent/40 bg-accent/10 text-white'
                                                    : 'border-white/[0.05] bg-white/[0.01] text-gray-500 hover:border-white/10 hover:text-gray-300'
                                            }`}
                                        >
                                            <span className="text-xs font-bold block">{s.label}</span>
                                            <span className="text-[10px] text-gray-500 mt-0.5 block leading-none truncate w-full">{s.desc}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderApiSetup = () => {
        const currentProvider = AI_PROVIDERS.find(p => p.id === selectedProvider)!;
        return (
            <div className="space-y-5">
                <p className="text-sm text-gray-400 leading-relaxed">
                    Provide API keys for providers you intend to query. Atheletia manages routing securely by model name.
                </p>
                {/* Providers grid */}
                <div className="space-y-2">
                    {AI_PROVIDERS.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => { setSelectedProvider(p.id); setApiKeyInput(settings?.[p.settingsKey] || ''); setApiKeySaved(false); }}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                                selectedProvider === p.id
                                    ? 'border-accent/40 bg-accent/10'
                                    : 'border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.03]'
                            }`}
                        >
                            <div className="flex items-center gap-2.5">
                                <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{p.name}</span>
                            </div>
                        </button>
                    ))}
                </div>
                {/* API key input */}
                <div className="space-y-2 p-4 rounded-2xl bg-white/[0.01] border border-white/[0.04] space-y-3">
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={apiKeyInput}
                            onChange={(e) => { setApiKeyInput(e.target.value); setApiKeySaved(false); }}
                            placeholder={currentProvider.placeholder}
                            className="flex-1 px-3 py-2 bg-white/[0.02] border border-white/[0.07] rounded-xl text-sm text-gray-200 placeholder-gray-650 focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 transition-all font-mono"
                        />
                        <button
                            onClick={handleSaveApiKey}
                            disabled={!apiKeyInput.trim() || apiKeySaved}
                            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                                apiKeySaved
                                    ? 'bg-green-500/20 border border-green-500/30 text-green-400'
                                    : 'bg-accent text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-30'
                            }`}
                        >
                            {apiKeySaved ? '✓ Saved' : 'Save Key'}
                        </button>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-gray-600 font-medium">Your key is stored locally and never shared.</span>
                        {settings?.[currentProvider.settingsKey] && !apiKeyInput && (
                            <span className="text-[10px] text-emerald-400 font-semibold">✓ Key exists in settings</span>
                        )}
                    </div>
                </div>
                <div className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-yellow-500/5 border border-yellow-500/10">
                    <Zap size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-yellow-350 leading-relaxed">Skip this step and add it later in <strong>Settings → API Keys</strong>.</p>
                </div>
            </div>
        );
    };

    const renderThemeSetup = () => (
        <div className="space-y-4">
            <p className="text-sm text-gray-400 leading-relaxed">
                Click a preset to apply the visual stylesheet <strong>live</strong>. All overrides persist instantly.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {THEME_PREVIEWS.map(({ id, name, bg, accent, border }) => (
                    <button
                        key={id}
                        onClick={() => handleThemeSelect(id)}
                        className={`rounded-2xl overflow-hidden border cursor-pointer transition-all ${
                            selectedTheme === id ? 'ring-2 ring-accent scale-[1.03]' : 'hover:scale-105'
                        }`}
                        style={{ background: bg, borderColor: selectedTheme === id ? accent : border }}
                    >
                        <div className="p-3">
                            <div className="h-3.5 rounded-lg mb-2" style={{ background: accent, width: '60%' }} />
                            <div className="h-2 rounded-lg mb-1" style={{ background: border, width: '90%' }} />
                            <div className="h-2 rounded-lg" style={{ background: border, width: '70%' }} />
                        </div>
                        <div className="px-3 pb-3 flex items-center justify-between">
                            <span className="text-[10px] font-bold" style={{ color: accent }}>{name}</span>
                            {selectedTheme === id && <CheckCircle2 size={11} style={{ color: accent }} />}
                        </div>
                    </button>
                ))}
            </div>
            <p className="text-[10px] text-gray-600 text-center font-medium">17 theme presets are configured — adjust scaling and layouts inside Settings.</p>
        </div>
    );

    const renderOverview = () => (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
                { icon: Activity, color: 'text-cyan-400', bg: 'bg-cyan-400/5', name: 'Dashboard', desc: 'Structured summary of daily timeline events & app usages.' },
                { icon: Activity, color: 'text-orange-400', bg: 'bg-orange-400/5', name: 'Activity Trackers', desc: 'Timeline visualizations of apps and active windows.' },
                { icon: BookOpen, color: 'text-purple-400', bg: 'bg-purple-400/5', name: 'AI Diary', desc: 'Isolated reflections combining automated and manual logs.' },
                { icon: Brain, color: 'text-pink-400', bg: 'bg-pink-400/5', name: 'Brain Notes', desc: 'Vault management for markdown files and long-term context.' },
                { icon: Zap, color: 'text-yellow-450', bg: 'bg-yellow-400/5', name: 'LeetCode Integrations', desc: 'Problem solving telemetry logs.' },
                { icon: Calendar, color: 'text-green-400', bg: 'bg-green-400/5', name: 'Schedule Sync', desc: 'Google Calendar and personal schedule integration.' },
                { icon: Timer, color: 'text-indigo-400', bg: 'bg-indigo-400/5', name: 'Focus Timer', desc: 'Zen mode with custom soundscapes and tasks.' },
                { icon: Dumbbell, color: 'text-emerald-400', bg: 'bg-emerald-400/5', name: 'Workout Log', desc: 'Weekly planner with YouTube visual tutorial guides.' },
            ].map(({ icon: Icon, color, bg, name, desc }) => (
                <div key={name} className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.01] border border-white/[0.04]">
                    <div className={`w-7.5 h-7.5 rounded-lg ${bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                        <Icon size={14} className={color} />
                    </div>
                    <div>
                        <p className="text-xs font-bold text-gray-200">{name}</p>
                        <p className="text-[10px] text-gray-500 mt-1 leading-normal">{desc}</p>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderPrivacy = () => {
        const toggleItems = [
            { label: 'App & Window Tracking', desc: 'Track which apps and windows you use.', checked: trackApps, onChange: setTrackApps, settingsKey: 'trackApps' },
            { label: 'Screen OCR Parsing', desc: 'Translate screenshots into raw text contexts.', checked: trackScreenOcr, onChange: setTrackScreenOcr, settingsKey: 'trackScreenOcr' },
            { label: 'Media Playback Logs', desc: 'Monitor active music, albums, and video details.', checked: trackMedia, onChange: setTrackMedia, settingsKey: 'trackMedia' },
            { label: 'Browser Activity Tracking', desc: 'Retrieve title metadata from top web engines.', checked: trackBrowser, onChange: setTrackBrowser, settingsKey: 'trackBrowser' },
            { label: 'Auto-Create Reflections', desc: 'Generate daily AI reflection scripts automatically.', checked: autoCreateDiary, onChange: setAutoCreateDiary, settingsKey: 'autoCreateDiary' },
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
            <div className="space-y-4">
                <p className="text-sm text-gray-400 leading-relaxed">
                    Verify telemetry configurations. All monitoring logs reside **locally** in isolated local databases.
                </p>
                <div className="rounded-2xl border border-white/[0.05] bg-white/[0.01] divide-y divide-white/[0.05]">
                    {toggleItems.map((item) => (
                        <div key={item.settingsKey} className="flex items-center justify-between px-4 py-3">
                            <div>
                                <p className="text-xs font-bold text-gray-200">{item.label}</p>
                                <p className="text-[10px] text-gray-500 mt-0.5 leading-normal">{item.desc}</p>
                            </div>
                            <button
                                onClick={() => handleToggle(item, !item.checked)}
                                className={`relative w-9 h-[20px] rounded-full transition-colors cursor-pointer ${item.checked ? 'bg-accent' : 'bg-white/10'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-[16px] h-[16px] rounded-full bg-white transition-transform ${item.checked ? 'translate-x-4.5' : ''}`} />
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-blue-500/5 border border-blue-500/10">
                    <ShieldCheck size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-blue-300 leading-normal">
                        Your private environment is safeguarded. No records are dispatched out unless required for AI api endpoints.
                    </p>
                </div>
            </div>
        );
    };

    const renderReady = () => (
        <div className="space-y-6">
            <p className="text-sm text-gray-400 leading-relaxed">
                Initial dashboard configuration is complete. Current parameters summary:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                    { label: 'Profile', val: profileName ? `${profileName} (${profileRole || 'User'})` : 'Not set', active: !!profileName },
                    { label: 'AI Key Config', val: apiKeySaved || settings?.nvidiaApiKey ? 'Keys saved — ready' : 'No key yet — add later', active: !!(settings?.nvidiaApiKey || apiKeySaved) },
                    { label: 'Preset Style', val: THEME_PREVIEWS.find(t => t.id === selectedTheme)?.name || selectedTheme, active: true },
                    { label: 'App Log', val: trackApps ? 'Monitoring active' : 'Log disabled', active: trackApps },
                    { label: 'Screen Scan', val: trackScreenOcr ? 'OCR active' : 'Scan disabled', active: trackScreenOcr },
                    { label: 'Reflections', val: autoCreateDiary ? 'Auto logs active' : 'Manual logs only', active: autoCreateDiary },
                ].map(({ label, val, active }) => (
                    <div key={label} className="p-3.5 rounded-2xl bg-white/[0.01] border border-white/[0.04] flex items-center justify-between">
                        <div>
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider block font-semibold">{label}</span>
                            <span className="text-xs font-bold text-gray-200 mt-1 block truncate max-w-[170px]">{val}</span>
                        </div>
                        <div className={`w-2 h-2 rounded-full ${active ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-yellow-400 shadow-[0_0_8px_#fbbf24]'}`} />
                    </div>
                ))}
            </div>
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-accent/5 border border-accent/15">
                <Sparkles size={16} className="text-accent flex-shrink-0" />
                <p className="text-xs text-white leading-normal font-semibold">
                    Athletia will assemble activity data tomorrow morning. Feel free to navigate!
                </p>
            </div>
        </div>
    );

    const stepData = [
        { title: 'Welcome to Athletia', subtitle: 'Your AI-powered personal productivity dashboard', render: renderWelcome, icon: Sparkles, color: 'text-cyan-400' },
        { title: 'Create Your Profile', subtitle: 'Personalize your assistant interactions', render: renderProfile, icon: User, color: 'text-purple-400' },
        { title: 'Set Up Your AI Key', subtitle: 'Connect an AI provider (you can skip this)', render: renderApiSetup, icon: Zap, color: 'text-yellow-450' },
        { title: 'Choose Your Theme', subtitle: 'Click to apply live — change anytime', render: renderThemeSetup, icon: Palette, color: 'text-pink-400' },
        { title: 'Privacy & Tracking', subtitle: 'Choose what Atheletia monitors', render: renderPrivacy, icon: ShieldCheck, color: 'text-emerald-400' },
        { title: 'App Overview', subtitle: 'What each section does', render: renderOverview, icon: Info, color: 'text-indigo-400' },
        { title: "You're All Set!", subtitle: "Atheletia is ready. Let's get started.", render: renderReady, icon: CheckCircle2, color: 'text-accent' },
    ];

    const step = stepData[currentStep];
    const StepIcon = step.icon;

    if (isProfileOnly) {
        // Dedicated Profile Editor Screen
        return (
            <div className="fixed inset-0 z-[200] flex flex-col md:flex-row overflow-hidden font-sans" style={{ background: 'var(--bg-app)' }}>
                {/* Left Pane - Premium card preview */}
                <div className="w-full md:w-[35%] border-r p-10 flex flex-col justify-between relative overflow-hidden flex-shrink-0" style={{ background: 'var(--bg-elev-1)', borderColor: 'var(--border-soft)' }}>
                    {/* Ambient Glows */}
                    <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-accent/5 blur-[120px] pointer-events-none" />
                    <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-purple-500/5 blur-[120px] pointer-events-none" />

                    <div>
                        <div className="flex items-center gap-2 mb-8">
                            <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" style={{ boxShadow: '0 0 10px var(--accent)' }} />
                            <span className="text-xs font-bold tracking-[0.2em]" style={{ color: 'var(--text-strong)' }}>ATHLETIA</span>
                        </div>
                        <h2 className="text-2xl font-black tracking-tight text-white mb-2 leading-tight">Profile & AI Memory</h2>
                        <p className="text-xs text-gray-500 leading-relaxed">
                            Fine-tune how Athletia personalizes interactions, code references, summaries, and tone configurations to your exact needs.
                        </p>
                    </div>

                    <div className="p-5 rounded-2xl bg-white/[0.02] border border-white/[0.05] relative overflow-hidden backdrop-blur-md">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-white shadow-lg text-lg" style={{ backgroundColor: profileColor }}>
                                {getInitials(profileName)}
                            </div>
                            <div>
                                <span className="text-sm font-bold text-white block">{profileName || 'Anonymous'}</span>
                                <span className="text-xs text-gray-500 block">{profileRole || 'User'}</span>
                            </div>
                        </div>
                        <div className="mt-4 pt-3 border-t border-white/[0.05] space-y-1.5 text-[10px] text-gray-500">
                            <div className="flex justify-between">
                                <span>AI Persona Tone:</span>
                                <span className="text-accent font-semibold">{profileTone}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Reading/Writing Style:</span>
                                <span className="text-accent font-semibold">{profileStyle}</span>
                            </div>
                        </div>
                    </div>

                    <div className="text-[10px] font-semibold tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                        Active Database Secured Locally
                    </div>
                </div>

                {/* Right Pane - Form area */}
                <div className="flex-1 p-8 md:p-12 overflow-y-auto flex flex-col justify-between relative" style={{ background: 'var(--bg-app)' }}>
                    <button
                        onClick={handleComplete}
                        className="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-xl transition-all cursor-pointer z-10"
                        style={{ color: 'var(--text-muted)', border: '1px solid var(--border-soft)', background: 'var(--bg-elev-1)' }}
                        onMouseEnter={e => e.currentTarget.style.color = 'var(--text-strong)'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                        title="Close editor"
                    >
                        <X size={15} />
                    </button>

                    <div className="w-full max-w-3xl mx-auto my-auto py-4">
                        <div className="flex items-center gap-3.5 mb-6">
                            <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                                <User size={18} />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-white">Edit Your Profile</h3>
                                <p className="text-xs text-gray-500">Modify details that dictate AI interaction contexts</p>
                            </div>
                        </div>

                        {renderProfile()}
                    </div>

                    <div className="w-full max-w-3xl mx-auto pt-6 border-t border-white/[0.05] flex items-center justify-between">
                        <span className="text-[10px] text-gray-600 font-medium">All inputs persist on key changes instantly.</span>
                        <button
                            onClick={handleComplete}
                            className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-accent text-[var(--accent-contrast)] hover:opacity-90 text-xs font-bold transition-all shadow-lg shadow-accent/20 cursor-pointer"
                        >
                            <CheckCircle2 size={14} />
                            Save & Close Changes
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[200] flex flex-col md:flex-row overflow-hidden font-sans" style={{ background: 'var(--bg-app)' }}>
            {/* Left Pane (Dashboard showcase) */}
            <div className="w-full md:w-[35%] border-r p-10 flex flex-col justify-between relative overflow-hidden flex-shrink-0" style={{ background: 'var(--bg-elev-1)', borderColor: 'var(--border-soft)' }}>
                {/* Ambient sphere glow */}
                <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-accent/5 blur-[120px] pointer-events-none" />
                <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-purple-500/5 blur-[120px] pointer-events-none" />

                <div>
                    <div className="flex items-center gap-2 mb-8">
                        <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" style={{ boxShadow: '0 0 10px var(--accent)' }} />
                        <span className="text-xs font-bold tracking-[0.2em]" style={{ color: 'var(--text-strong)' }}>ATHLETIA</span>
                    </div>
                    <h2 className="text-3xl font-black tracking-tight text-white mb-2 leading-tight">Welcome Dashboard</h2>
                    <p className="text-xs text-gray-500 leading-relaxed">
                        A local smart logger and insights workspace designed around your private timelines.
                    </p>
                </div>

                {/* Progress Indicators in Left Pane */}
                <div className="space-y-4 my-8">
                    {stepData.map((s, idx) => {
                        const isCurrent = idx === currentStep;
                        const isPast = idx < currentStep;
                        const StepIconLocal = s.icon;
                        return (
                            <div key={s.title} className="flex items-center gap-3.5 transition-all">
                                <div className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-all ${
                                    isCurrent 
                                        ? 'border-accent bg-accent/15 text-white shadow-[0_0_12px_var(--accent)] scale-105'
                                        : isPast
                                        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                                        : 'border-white/[0.04] bg-white/[0.01] text-gray-650'
                                }`}>
                                    <StepIconLocal size={14} />
                                </div>
                                <div className="text-left">
                                    <span className={`text-xs font-bold block ${isCurrent ? 'text-white' : isPast ? 'text-gray-400' : 'text-gray-600'}`}>
                                        {s.title}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="text-[10px] font-semibold tracking-wide uppercase leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Designed for visual comfort & performance
                </div>
            </div>

            {/* Right Pane (Dynamic forms) */}
            <div className="flex-1 p-8 md:p-16 overflow-y-auto flex flex-col justify-between relative" style={{ background: 'var(--bg-app)' }}>
                {/* Close/Skip button */}
                <button
                    onClick={handleComplete}
                    className="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-xl transition-all cursor-pointer z-10"
                    style={{ color: 'var(--text-muted)', border: '1px solid var(--border-soft)', background: 'var(--bg-elev-1)' }}
                    onMouseEnter={e => e.currentTarget.style.color = 'var(--text-strong)'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                    title="Skip onboarding"
                >
                    <X size={15} />
                </button>

                <div className="w-full max-w-3xl mx-auto my-auto py-6">
                    <div className={`transition-opacity duration-200 ${isAnimating ? 'opacity-0' : 'opacity-100'} space-y-6`}>
                        {/* Title header */}
                        <div className="flex items-center gap-4 mb-2">
                            <div className={`w-10 h-10 rounded-2xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-center ${step.color}`}>
                                <StepIcon size={18} />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-white leading-none">{step.title}</h3>
                                <p className="text-xs text-gray-500 mt-1.5">{step.subtitle}</p>
                            </div>
                        </div>

                        {/* Rendering step form content */}
                        <div className="py-2">
                            {step.render()}
                        </div>
                    </div>
                </div>

                {/* Navigation Toolbar */}
                <div className="w-full max-w-3xl mx-auto pt-6 border-t border-white/[0.05] flex items-center justify-between">
                    <div className="flex justify-center gap-1.5">
                        {stepData.map((_, i) => (
                            <div
                                key={i}
                                className={`rounded-full transition-all duration-300 ${
                                    i === currentStep
                                        ? 'w-5 h-1.5 bg-accent'
                                        : i < currentStep
                                        ? 'w-1.5 h-1.5 bg-accent/40'
                                        : 'w-1.5 h-1.5 bg-white/10'
                                }`}
                            />
                        ))}
                    </div>

                    <div className="flex items-center gap-3">
                        {!isFirst && (
                            <button
                                onClick={() => navigate('prev')}
                                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06] text-gray-300 hover:text-white text-xs font-bold transition-colors cursor-pointer"
                            >
                                <ArrowLeft size={14} />
                                Back
                            </button>
                        )}
                        {isLast ? (
                            <div className="flex gap-2">
                                <button
                                    onClick={handleCompleteAndGoToSettings}
                                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06] text-gray-300 hover:text-white text-xs font-bold transition-colors cursor-pointer"
                                >
                                    <Eye size={14} />
                                    Open Settings
                                </button>
                                <button
                                    onClick={handleComplete}
                                    className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-[var(--accent-contrast)] hover:opacity-90 text-xs font-bold transition-all shadow-lg shadow-accent/20 cursor-pointer"
                                >
                                    <CheckCircle2 size={14} />
                                    Get Started
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => navigate('next')}
                                className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-accent text-[var(--accent-contrast)] hover:opacity-90 text-xs font-bold transition-all shadow-lg shadow-accent/20 cursor-pointer"
                            >
                                Next
                                <ArrowRight size={14} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export const Onboarding: React.FC = () => {
    const showOnboarding = useIntentStore((s) => s.showOnboarding);
    const setShowOnboarding = useIntentStore((s) => s.setShowOnboarding);
    const setOnboardingStep = useIntentStore((s) => s.setOnboardingStep);

    useEffect(() => {
        const done = localStorage.getItem(ONBOARDED_KEY);
        if (!done) {
            const timer = setTimeout(() => {
                setOnboardingStep(0);
                setShowOnboarding(true);
            }, 800);
            return () => clearTimeout(timer);
        }
    }, [setShowOnboarding, setOnboardingStep]);

    if (!showOnboarding) return null;

    return (
        <OnboardingModal
            onComplete={() => {
                setShowOnboarding(false);
                setOnboardingStep(0);
            }}
        />
    );
};
