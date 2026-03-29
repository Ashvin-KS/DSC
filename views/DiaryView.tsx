import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Sparkles, PenLine, ChevronLeft, ChevronRight, Loader2, Trash2, CalendarClock } from 'lucide-react';

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

function formatDisplayDate(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function addDays(dateStr: string, n: number): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

export const DiaryView: React.FC = () => {
    const [activeDate, setActiveDate] = useState(todayStr());
    const [entries, setEntries] = useState<DiaryEntry[]>([]);
    const [yesterdaySummary, setYesterdaySummary] = useState<DiaryEntry | null>(null);
    const [yesterdaySummaryError, setYesterdaySummaryError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState('');
    const [newContent, setNewContent] = useState('');
    const [isSavingManual, setIsSavingManual] = useState(false);
    const [isGeneratingYesterday, setIsGeneratingYesterday] = useState(false);
    const textRef = useRef<HTMLTextAreaElement>(null);

    const currentDateEntries = entries.filter(e => e.date === activeDate);
    const aiEntries = currentDateEntries.filter(e => e.isAiGenerated);
    const manualEntries = currentDateEntries.filter(e => !e.isAiGenerated);
    const yesterdayDate = addDays(todayStr(), -1);

    // Load entries for the active date
    useEffect(() => {
        const load = async () => {
            try {
                if (window.nexusAPI?.diary) {
                    const data = await window.nexusAPI.diary.getEntries(activeDate);
                    setEntries(data);
                } else {
                    // Stub offline preview
                    if (activeDate === todayStr() && entries.length === 0) {
                        const now = Math.floor(Date.now() / 1000);
                        setEntries([{
                            id: 'stub-1',
                            date: todayStr(),
                            content: '*(This is a sample AI-generated diary entry. Connect the backend to load your real activity-based diary.)*\n\nToday was productive. You spent most of your morning in VS Code working on the Allentire project — specifically implementing the ChatView and ActivityView components. In the afternoon you explored the IntentFlow architecture documentation. Lofi Hip Hop played in the background for about 2 hours.',
                            isAiGenerated: true,
                            createdAt: Date.now() / 1000,
                            updatedAt: Date.now() / 1000,
                        }]);
                    }
                }
            } catch { /* offline */ }
        };
        load();
    }, [activeDate]);

    useEffect(() => {
        const loadYesterdaySummary = async () => {
            try {
                if (!window.nexusAPI?.diary) {
                    setYesterdaySummary(null);
                    return;
                }
                const data = await window.nexusAPI.diary.getEntries(yesterdayDate);
                const latestAi = (data || []).find((entry: DiaryEntry) => entry.isAiGenerated) || null;
                setYesterdaySummary(latestAi);
            } catch {
                setYesterdaySummary(null);
            }
        };
        loadYesterdaySummary();
    }, [yesterdayDate]);

    const handleGenerateYesterdaySummary = async () => {
        setIsGeneratingYesterday(true);
        setYesterdaySummaryError(null);
        try {
            if (window.nexusAPI?.diary) {
                const content = await window.nexusAPI.diary.generateEntry(yesterdayDate);
                const now = Date.now() / 1000;
                const generated: DiaryEntry = {
                    id: `ai-yesterday-${Date.now()}`,
                    date: yesterdayDate,
                    content,
                    isAiGenerated: true,
                    createdAt: now,
                    updatedAt: now,
                };
                try {
                    const saved = await window.nexusAPI.diary.saveEntry(generated);
                    setYesterdaySummary(saved);
                    if (activeDate === yesterdayDate) {
                        setEntries(p => [saved, ...p.filter(e => e.id !== saved.id)]);
                    }
                } catch {
                    setYesterdaySummary(generated);
                    if (activeDate === yesterdayDate) {
                        setEntries(p => [generated, ...p.filter(e => e.id !== generated.id)]);
                    }
                }
            } else {
                setYesterdaySummaryError('Diary backend is unavailable in this runtime.');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to generate summary.';
            setYesterdaySummaryError(message);
        }
        setIsGeneratingYesterday(false);
    };

    const handleAddManual = async () => {
        if (!newContent.trim()) return;
        setIsSavingManual(true);
        const now = Math.floor(Date.now() / 1000);
        const entry: DiaryEntry = {
            id: `manual-${Date.now()}`, date: activeDate, content: newContent.trim(),
            isAiGenerated: false, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
        };
        try {
            if (window.nexusAPI?.diary) {
                const saved = await window.nexusAPI.diary.saveEntry(entry);
                setEntries(p => [saved, ...p]);
            } else {
                setEntries(p => [entry, ...p]);
            }
        } catch {
            setEntries(p => [entry, ...p]);
        }
        setNewContent('');
        setIsSavingManual(false);
    };

    const handleSaveEdit = async () => {
        if (!editingId) return;
        const now = Date.now() / 1000;
        setEntries(p => p.map(e => e.id === editingId ? { ...e, content: editContent, updatedAt: now } : e));
        try {
            const entry = entries.find(e => e.id === editingId);
            if (entry && window.nexusAPI?.diary) {
                await window.nexusAPI.diary.saveEntry({ ...entry, content: editContent, updatedAt: now });
            }
        } catch { /* offline */ }
        setEditingId(null);
    };

    const handleDelete = async (id: string) => {
        setEntries(p => p.filter(e => e.id !== id));
        try { await window.nexusAPI?.diary?.deleteEntry(id); } catch { /* offline */ }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-6 md:px-10 pt-2 pb-4">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">Diary</h1>
                    <p className="text-xs text-gray-500">Personal dashboard + AI reflections + manual notes</p>
                </div>


            </div>

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
                    {activeDate === todayStr() && <p className="text-[10px] text-cyan-500 mt-0.5 font-medium">TODAY</p>}
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
            <div className="flex-1 overflow-y-auto px-6 md:px-10 pb-10 space-y-4">
                <div className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-5">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <CalendarClock size={12} /> Personal Dashboard
                            </p>
                            <p className="text-sm font-semibold text-white mt-1">Yesterday AI Summary</p>
                            <p className="text-[11px] text-gray-500">{formatDisplayDate(yesterdayDate)}</p>
                        </div>
                        <button
                            onClick={handleGenerateYesterdaySummary}
                            disabled={isGeneratingYesterday}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/15 transition-all text-xs font-medium disabled:opacity-50"
                        >
                            {isGeneratingYesterday ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                            {yesterdaySummary ? 'Refresh Summary' : 'Generate Summary'}
                        </button>
                    </div>

                    {yesterdaySummary ? (
                        <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-[#121212] prose-code:text-cyan-300 prose-code:before:content-none prose-code:after:content-none text-gray-300">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{yesterdaySummary.content}</ReactMarkdown>
                        </div>
                    ) : (
                        <p className="text-sm text-gray-500">No AI summary yet for yesterday. Click “Generate Summary”.</p>
                    )}
                    {yesterdaySummaryError && (
                        <p className="text-xs text-red-400 mt-3">{yesterdaySummaryError}</p>
                    )}
                </div>

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
                            className="px-4 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 text-xs font-medium transition-colors disabled:opacity-50"
                        >
                            {isSavingManual ? 'Saving…' : 'Save Note'}
                        </button>
                    </div>
                </div>

                {currentDateEntries.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-56 text-gray-600">
                        <BookOpen size={36} className="mb-3 opacity-40" />
                        <p className="text-sm">No entries for this day yet.</p>
                        <p className="text-xs mt-1">Use "Generate Summary" above to create one from yesterday's activity, or add a manual note above.</p>
                    </div>
                ) : currentDateEntries.map(entry => (
                    <div key={entry.id} className="bg-[#111] border border-[#1e1e1e] rounded-2xl p-5">
                        {/* Entry header */}
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                {entry.isAiGenerated
                                    ? <span className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider"><Sparkles size={9} /> AI Generated</span>
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
                                        className="px-4 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 text-xs font-medium transition-colors">
                                        Save
                                    </button>
                                    <button onClick={() => setEditingId(null)}
                                        className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-[#282828] text-gray-400 hover:text-white text-xs transition-colors">
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">{entry.content}</p>
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