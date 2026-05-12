import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavStore } from '../store/useNavStore';
import { useIntentStore } from '../store/useIntentStore';
import { useLeetCodeActivityStore } from '../store/useLeetCodeActivityStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { BookOpen, Sparkles, PenLine, ChevronLeft, ChevronRight, Loader2, Trash2, CalendarClock, BellRing, CheckCircle2 } from 'lucide-react';
import { getProviderKey, resolveProviderForModel } from '../lib/modelFetch';
import { StatusBanner } from '../components/ui/StatusBanner';

interface DiaryEntry {
    id: string;
    date: string;
    content: string;
    isAiGenerated: boolean;
    createdAt: number;
    updatedAt: number;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

function formatDisplayDate(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function addDays(dateStr: string, n: number): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

function getDiaryErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
        return error;
    }
    return fallback;
}

/** Auto-create key stored in localStorage to avoid duplicate auto-creation */
const getAutoCreateKey = (date: string) => `diary_auto_created_${date}`;

export const DiaryView: React.FC = () => {
    const setHasUnsavedChanges = useNavStore(s => s.setHasUnsavedChanges);
    const { settings, setSettings } = useIntentStore();
    const [activeDate, setActiveDate] = useState(todayStr());
    const [entries, setEntries] = useState<DiaryEntry[]>([]);
    const [aiSummary, setAiSummary] = useState<DiaryEntry | null>(null);
    const [aiSummaryError, setAiSummaryError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState('');
    const [newContent, setNewContent] = useState('');
    const [isSavingManual, setIsSavingManual] = useState(false);
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
    const [autoCreateMsg, setAutoCreateMsg] = useState<string | null>(null);
    const [entryStatusMsg, setEntryStatusMsg] = useState<string | null>(null);
    const textRef = useRef<HTMLTextAreaElement>(null);

    // Auto-create diary setting (stored in settings via key autoCreateDiary)
    const autoCreateEnabled = !!((settings as any)?.autoCreateDiary ?? false);

    const toggleAutoCreate = () => {
        if (settings) {
            const updated = { ...settings, autoCreateDiary: !autoCreateEnabled } as any;
            setSettings(updated);
            try { window.atheletiaAPI?.settings?.save?.(updated); } catch { /* offline */ }
        }
    };

    useEffect(() => {
        setHasUnsavedChanges(newContent.trim().length > 0 || (editingId !== null && editContent.trim().length > 0));
    }, [newContent, editingId, editContent, setHasUnsavedChanges]);

    const currentDateEntries = entries.filter(e => e.date === activeDate);
    const manualEntries = currentDateEntries.filter(e => !e.isAiGenerated);
    const aiEntries = currentDateEntries.filter(e => e.isAiGenerated);

    const getDefaultModelProvider = useCallback(() => {
        return resolveProviderForModel((settings as any)?.defaultModel || '');
    }, [settings]);

    const getApiKey = useCallback(() => {
        const provider = getDefaultModelProvider();
        const key = getProviderKey(settings, provider);
        if (key) return key;
        const fallbacks = ['openai', 'nvidia', 'anthropic', 'groq', 'gemini'];
        for (const p of fallbacks) {
            const k = getProviderKey(settings, p);
            if (k) return k;
        }
        return '';
    }, [settings, getDefaultModelProvider]);

    const getEffectiveProvider = useCallback(() => {
        const provider = getDefaultModelProvider();
        const key = getProviderKey(settings, provider);
        if (key) return provider;
        const fallbacks = ['openai', 'nvidia', 'anthropic', 'groq', 'gemini'];
        for (const p of fallbacks) {
            const k = getProviderKey(settings, p);
            if (k) return p;
        }
        return provider;
    }, [settings, getDefaultModelProvider]);

    // Load entries for the ACTIVE DATE ONLY — no cross-date contamination
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                if (window.atheletiaAPI?.diary) {
                    setEntryStatusMsg(null);
                    const data: DiaryEntry[] = await window.atheletiaAPI.diary.getEntries(activeDate);
                    if (cancelled) return;
                    const dateFiltered = (data || []).filter((e: DiaryEntry) => e.date === activeDate);
                    setEntries(dateFiltered);
                    const latestAi = dateFiltered.find((e: DiaryEntry) => e.isAiGenerated) || null;
                    setAiSummary(latestAi);
                } else {
                    if (!cancelled) {
                        setEntries([]);
                        setAiSummary(null);
                        setEntryStatusMsg('Diary backend is unavailable in this runtime.');
                    }
                }
            } catch (error) {
                if (!cancelled) {
                    setEntryStatusMsg(`Unable to load diary entries: ${getDiaryErrorMessage(error, 'Unknown error')}`);
                }
            }
        };
        load();
        return () => { cancelled = true; };
    }, [activeDate]);

    /** Core summary generation — tied strictly to `targetDate` */
    const generateSummaryForDate = useCallback(async (targetDate: string, silent = false) => {
        if (!silent) {
            setIsGeneratingSummary(true);
            setAiSummaryError(null);
        }
        try {
            if (!window.atheletiaAPI?.diary) {
                if (!silent) setAiSummaryError('Diary backend is unavailable in this runtime.');
                return null;
            }
            const apiKey = getApiKey();
            if (!apiKey) {
                if (!silent) setAiSummaryError('No API key configured. Go to Settings → API Keys to add one for your selected provider.');
                return null;
            }

            // Gather ONLY this date's LeetCode context
            const leetCodeActivity = useLeetCodeActivityStore.getState().getDayActivity(targetDate);
            let extraContext = `Date: ${targetDate}\n`;
            if (leetCodeActivity && leetCodeActivity.count > 0) {
                extraContext += `LeetCode Submissions: ${leetCodeActivity.count} problems solved on ${targetDate}.\n`;
            }
            extraContext += `[Only summarize activities from ${targetDate}. Do not reference other dates.]\n`;

            const rawModel = (settings as any)?.defaultModel || undefined;
            const defaultProvider = getDefaultModelProvider();
            const provider = getEffectiveProvider();
            const model = (provider === defaultProvider) ? rawModel : undefined;
            const content = await window.atheletiaAPI.diary.generateEntry(targetDate, extraContext, model, apiKey, provider);
            if (!content || typeof content !== 'string' || !content.trim()) {
                if (!silent) setAiSummaryError('AI returned an empty summary. Ensure your API key is valid and the provider is reachable.');
                return null;
            }
            const now = Math.floor(Date.now() / 1000);
            const generated: DiaryEntry = {
                id: `ai-${targetDate}-${Date.now()}`,
                date: targetDate,
                content,
                isAiGenerated: true,
                createdAt: now,
                updatedAt: now,
            };
            try {
                const saved = await window.atheletiaAPI.diary.saveEntry(generated);
                return saved;
            } catch {
                return generated;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const friendly = message.toLowerCase().includes('api key')
                ? '🔑 API key error — check Settings → API Keys.'
                : message.toLowerCase().includes('network') || message.toLowerCase().includes('fetch')
                ? '🌐 Network error — check your internet connection.'
                : `Failed to generate summary: ${message}`;
            if (!silent) setAiSummaryError(friendly);
            return null;
        } finally {
            if (!silent) setIsGeneratingSummary(false);
        }
    }, [getApiKey]);

    const handleGenerateSummary = async () => {
        const result = await generateSummaryForDate(activeDate);
        if (result) {
            setAiSummary(result);
            setEntries(p => [result, ...p.filter(e => e.id !== result.id)]);
        }
    };

    // ── Auto-create today's diary at 8 PM (retry until 8 AM) ─────────────────
    useEffect(() => {
        if (!autoCreateEnabled) return;

        const runAutoCreate = async (targetDate: string) => {
            const key = getAutoCreateKey(targetDate);
            if (localStorage.getItem(key)) return true;

            try {
                if (!window.atheletiaAPI?.diary) {
                    console.log(`[Diary] Auto-create skipped for ${targetDate}: diary backend unavailable`);
                    return false;
                }
                const existing: DiaryEntry[] = await window.atheletiaAPI.diary.getEntries(targetDate);
                const hasAi = (existing || []).some((e: DiaryEntry) => e.isAiGenerated && e.date === targetDate);
                if (hasAi) {
                    localStorage.setItem(key, '1');
                    return true;
                }
                const apiKey = getApiKey();
                if (!apiKey) {
                    console.log(`[Diary] Auto-create failed for ${targetDate}: no API key configured`);
                    return false;
                }
                console.log(`[Diary] Auto-creating diary for ${targetDate}...`);
                const result = await generateSummaryForDate(targetDate, true);
                if (result) {
                    localStorage.setItem(key, '1');
                    console.log(`[Diary] Auto-created diary for ${targetDate}`);
                    if (activeDate === targetDate) {
                        setAiSummary(result);
                        setEntries(p => [result, ...p.filter(e => e.id !== result.id)]);
                    }
                    return true;
                }
                console.log(`[Diary] Auto-create returned empty for ${targetDate}`);
            } catch (err) {
                console.log(`[Diary] Auto-create failed for ${targetDate}:`, err);
            }
            return false;
        };

        const now = new Date();
        const today = todayStr();
        const yesterday = yesterdayStr();
        const currentHour = now.getHours();

        // Retry window: 8 PM (20:00) to 8 AM (08:00)
        const isInRetryWindow = currentHour >= 20 || currentHour < 8;

        // If past 8 PM, start retrying today's entry immediately
        // If before 8 AM, also retry (might have failed overnight)
        if (isInRetryWindow && !localStorage.getItem(getAutoCreateKey(today))) {
            let attempts = 0;
            const maxAttempts = 24; // ~2 hours of retries at 5-min intervals
            const retryInterval = setInterval(async () => {
                const hour = new Date().getHours();
                if (hour >= 8 && hour < 20) {
                    clearInterval(retryInterval);
                    return; // outside window, stop
                }
                attempts++;
                if (attempts > maxAttempts) {
                    clearInterval(retryInterval);
                    return;
                }
                const success = await runAutoCreate(today);
                if (success) clearInterval(retryInterval);
            }, 5 * 60 * 1000); // every 5 minutes
            runAutoCreate(today); // first attempt immediately

            // Cleanup on unmount or when deps change
            return () => clearInterval(retryInterval);
        }

        // Catch up yesterday if missed (one-shot, no retry)
        if (!localStorage.getItem(getAutoCreateKey(yesterday))) {
            runAutoCreate(yesterday);
        }

        // Schedule timer for next 8 PM
        const next8pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 5);
        if (next8pm <= now) {
            next8pm.setDate(next8pm.getDate() + 1);
        }
        const msUntil8pm = next8pm.getTime() - now.getTime();
        const timer = setTimeout(() => {
            const targetDay = todayStr();
            let attempts = 0;
            const maxAttempts = 24;
            const retryInterval = setInterval(async () => {
                const hour = new Date().getHours();
                if (hour >= 8 && hour < 20) {
                    clearInterval(retryInterval);
                    return;
                }
                attempts++;
                if (attempts > maxAttempts) {
                    clearInterval(retryInterval);
                    return;
                }
                const success = await runAutoCreate(targetDay);
                if (success) clearInterval(retryInterval);
            }, 5 * 60 * 1000);
            runAutoCreate(targetDay);
        }, msUntil8pm);

        return () => clearTimeout(timer);
    }, [autoCreateEnabled, generateSummaryForDate, activeDate]);

    const handleAddManual = async () => {
        if (!newContent.trim()) return;
        setIsSavingManual(true);
        const entry: DiaryEntry = {
            id: `manual-${Date.now()}`, date: activeDate, content: newContent.trim(),
            isAiGenerated: false, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000),
        };
        try {
            if (window.atheletiaAPI?.diary) {
                const saved = await window.atheletiaAPI.diary.saveEntry(entry);
                setEntries(p => [saved, ...p]);
                setNewContent('');
                setEntryStatusMsg(null);
            } else {
                setEntryStatusMsg('Diary backend is unavailable in this runtime.');
            }
        } catch (error) {
            setEntryStatusMsg(`Failed to save manual note: ${getDiaryErrorMessage(error, 'Unknown error')}`);
        }
        finally {
            setIsSavingManual(false);
        }
    };

    const handleSaveEdit = async () => {
        if (!editingId) return;
        const now = Math.floor(Date.now() / 1000);
        try {
            const entry = entries.find(e => e.id === editingId);
            if (entry && window.atheletiaAPI?.diary) {
                const saved = await window.atheletiaAPI.diary.saveEntry({ ...entry, content: editContent, updatedAt: now });
                setEntries(p => p.map(e => e.id === editingId ? saved : e));
                setEntryStatusMsg(null);
                setEditingId(null);
            } else if (!window.atheletiaAPI?.diary) {
                setEntryStatusMsg('Diary backend is unavailable in this runtime.');
            }
        } catch (e) {
            setEntryStatusMsg(`Failed to save edit: ${getDiaryErrorMessage(e, 'Unknown error')}`);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            if (window.atheletiaAPI?.diary) {
                await window.atheletiaAPI.diary.deleteEntry(id);
                setEntries(p => p.filter(e => e.id !== id));
                if (aiSummary?.id === id) setAiSummary(null);
                setEntryStatusMsg(null);
            } else {
                setEntryStatusMsg('Diary backend is unavailable in this runtime.');
            }
        } catch (e) {
            setEntryStatusMsg(`Failed to delete entry: ${getDiaryErrorMessage(e, 'Unknown error')}`);
        }
    };

    const isToday = activeDate === todayStr();

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-6 md:px-10 pt-2 pb-4">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">Diary</h1>
                    <p className="text-xs text-gray-500">Personal dashboard + AI reflections + manual notes</p>
                </div>
                {/* Auto-create toggle */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={toggleAutoCreate}
                        title="Auto-create diary entry for today at 8 PM"
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                            autoCreateEnabled
                                ? 'bg-[var(--accent-soft)] border-accent/30 text-accent'
                                : 'bg-transparent border-[#2a2a2a] text-gray-500 hover:text-gray-300'
                        }`}
                    >
                        <BellRing size={12} />
                        Auto-Create
                    </button>
                </div>
            </div>

            {/* Auto-create notification */}
            {autoCreateMsg && (
                <div className="mx-6 md:mx-10 mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent-soft)] border border-accent/20 text-accent text-xs">
                    <CheckCircle2 size={13} />
                    {autoCreateMsg}
                </div>
            )}

            {entryStatusMsg && (
                <div className="mx-6 md:mx-10 mb-3">
                    <StatusBanner
                        tone="error"
                        title="Diary action failed"
                        message={entryStatusMsg}
                        action={
                            <button
                                onClick={() => setEntryStatusMsg(null)}
                                className="rounded-md border border-red-400/30 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/15"
                            >
                                Dismiss
                            </button>
                        }
                    />
                </div>
            )}

            {/* Date Navigation */}
            <div className="flex items-center gap-4 px-6 md:px-10 pb-5">
                <button
                    onClick={() => setActiveDate(addDays(activeDate, -1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#161616] border border-[#262626] text-gray-500 hover:text-white hover:border-[#333] transition-colors"
                >
                    <ChevronLeft size={14} />
                </button>
                <div className="flex-1 text-center">
                    <p className="text-sm font-semibold text-white">{formatDisplayDate(activeDate)}</p>
                    {isToday && <p className="text-[10px] text-accent mt-0.5 font-medium">TODAY</p>}
                    {activeDate === yesterdayStr() && <p className="text-[10px] text-gray-500 mt-0.5 font-medium">YESTERDAY</p>}
                </div>
                <button
                    onClick={() => setActiveDate(addDays(activeDate, 1))}
                    disabled={activeDate >= todayStr()}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#161616] border border-[#262626] text-gray-500 hover:text-white hover:border-[#333] transition-colors disabled:opacity-30"
                >
                    <ChevronRight size={14} />
                </button>
            </div>

            {/* Entries */}
            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 md:px-10 pb-10 space-y-4">
                {/* AI Summary Card */}
                <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-5">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <CalendarClock size={12} /> Personal Dashboard
                            </p>
                            <p className="text-sm font-semibold text-white mt-1">
                                {isToday ? "Today's AI Summary" : 'AI Daily Summary'}
                            </p>
                            <p className="text-[11px] text-gray-500">{formatDisplayDate(activeDate)}</p>
                        </div>
                        {/* Allow generating summary for any past date including yesterday — never for today */}
                        {!isToday && (
                            <button
                                onClick={handleGenerateSummary}
                                disabled={isGeneratingSummary}
                                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent-soft)] border border-accent/20 text-accent hover:bg-accent/15 transition-all text-xs font-medium disabled:opacity-50"
                            >
                                {isGeneratingSummary ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                {aiSummary ? 'Refresh Summary' : 'Generate Summary'}
                            </button>
                        )}
                    </div>

                    {isToday ? (
                        <div className="space-y-2">
                            <p className="text-sm text-gray-500 italic">
                                Today's summary will be available tomorrow. Add your manual notes below for today.
                            </p>
                            {autoCreateEnabled && (
                                <p className="text-xs text-gray-600">
                                    <span className="text-accent font-medium">Auto-Create is ON</span> — a summary for today will be automatically generated at 8 PM.
                                </p>
                            )}
                        </div>
                    ) : aiSummary ? (
                        <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-[#121212] prose-code:text-accent prose-code:before:content-none prose-code:after:content-none text-gray-300">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{aiSummary.content}</ReactMarkdown>
                        </div>
                    ) : (
                        <p className="text-sm text-gray-500">No AI summary yet for {formatDisplayDate(activeDate)}. Click "Generate Summary".</p>
                    )}
                    {aiSummaryError && (
                        <p className="text-xs text-red-400 mt-3">{aiSummaryError}</p>
                    )}
                </div>

                {/* Manual Notes Card */}
                <div className="bg-[#111] border border-[#2a2a2a] rounded-2xl p-5">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <PenLine size={12} /> Manual Notes
                    </p>
                    <textarea
                        ref={textRef}
                        value={newContent}
                        onChange={e => setNewContent(e.target.value)}
                        placeholder="Write your own note for this date..."
                        rows={5}
                        className="w-full resize-none bg-[#0a0a0a] border border-[#222] rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                    />
                    <div className="flex justify-between items-center mt-3">
                        <p className="text-[11px] text-gray-500">Saved under {formatDisplayDate(activeDate)}</p>
                        <button
                            onClick={handleAddManual}
                            disabled={!newContent.trim() || isSavingManual}
                            className="px-4 py-2 rounded-lg bg-[var(--accent-soft)] border border-accent/20 text-accent hover:bg-[var(--accent-soft)] text-xs font-medium transition-colors disabled:opacity-50"
                        >
                            {isSavingManual ? 'Saving…' : 'Save Note'}
                        </button>
                    </div>
                </div>

                {currentDateEntries.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-gray-600">
                        <BookOpen size={32} className="mb-3 opacity-40" />
                        <p className="text-sm">No entries for {formatDisplayDate(activeDate)} yet.</p>
                        {!isToday && (
                            <p className="text-xs mt-1">Use "Generate Summary" above or add a manual note.</p>
                        )}
                    </div>
                ) : currentDateEntries.map(entry => (
                    <div key={entry.id} className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-5">
                        {/* Entry header */}
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                {entry.isAiGenerated
                                    ? <span className="flex items-center gap-1 text-[10px] text-accent bg-[var(--accent-soft)] border border-accent/20 px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider"><Sparkles size={9} /> AI Generated</span>
                                    : <span className="flex items-center gap-1 text-[10px] text-gray-400 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider"><PenLine size={9} /> Manual</span>
                                }
                            </div>
                            <div className="flex items-center gap-1">
                                {editingId !== entry.id && (
                                    <button onClick={() => { setEditingId(entry.id); setEditContent(entry.content); }}
                                        className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors">
                                        <PenLine size={13} />
                                    </button>
                                )}
                                <button onClick={() => handleDelete(entry.id)}
                                    className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-600 hover:text-red-400 hover:bg-white/5 transition-colors">
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        </div>

                        {/* Content */}
                        {editingId === entry.id ? (
                            <div>
                                <textarea
                                    value={editContent}
                                    onChange={e => setEditContent(e.target.value)}
                                    autoFocus
                                    rows={6}
                                    className="w-full resize-none bg-[#0a0a0a] border border-[#222] rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                                />
                                <div className="flex gap-2 mt-3">
                                    <button onClick={handleSaveEdit}
                                        className="px-4 py-2 rounded-lg bg-[var(--accent-soft)] border border-accent/20 text-accent hover:bg-[var(--accent-soft)] text-xs font-medium transition-colors">
                                        Save
                                    </button>
                                    <button onClick={() => setEditingId(null)}
                                        className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-[#282828] text-gray-400 hover:text-white text-xs transition-colors">
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            entry.isAiGenerated ? (
                                <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-[#121212] prose-code:text-accent prose-code:before:content-none prose-code:after:content-none text-gray-300">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{entry.content}</ReactMarkdown>
                                </div>
                            ) : (
                                <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">{entry.content}</p>
                            )
                        )}
                    </div>
                ))}

                {manualEntries.length > 0 && (
                    <p className="text-[11px] text-gray-600 text-right">{manualEntries.length} manual note{manualEntries.length > 1 ? 's' : ''} • {aiEntries.length} AI entr{aiEntries.length === 1 ? 'y' : 'ies'}</p>
                )}
            </div>
        </div>
    );
};
