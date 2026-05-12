import React, { useState, useEffect, useMemo } from 'react';
import {
    Activity, Clock, Monitor, Globe, Headphones, Terminal, Puzzle,
    HelpCircle, ChevronDown, ChevronUp, RefreshCw, BarChart2, Filter,
} from 'lucide-react';
import { StatusBanner } from '../components/ui/StatusBanner';

interface ActivityEntry {
    id: number;
    appName: string;
    windowTitle: string;
    categoryId: number;
    startTime: number;
    durationSeconds: number;
}

const CATEGORY_META: Record<number, { label: string; color: string; bg: string; icon: React.ElementType }> = {
    1: { label: 'Development', color: 'text-cyan-400', bg: 'bg-cyan-500/10', icon: Terminal },
    2: { label: 'Browser', color: 'text-blue-400', bg: 'bg-blue-500/10', icon: Globe },
    3: { label: 'Communication', color: 'text-green-400', bg: 'bg-green-500/10', icon: Puzzle },
    4: { label: 'Entertainment', color: 'text-purple-400', bg: 'bg-purple-500/10', icon: Headphones },
    5: { label: 'Productivity', color: 'text-amber-400', bg: 'bg-amber-500/10', icon: Monitor },
    6: { label: 'System', color: 'text-gray-400', bg: 'bg-gray-500/10', icon: Monitor },
    7: { label: 'Other', color: 'text-gray-500', bg: 'bg-white/5', icon: HelpCircle },
};

const TIME_RANGES = [
    { id: 'today', label: 'Today', seconds: () => { const now = Math.floor(Date.now() / 1000); const start = new Date(); start.setHours(0, 0, 0, 0); return { start: Math.floor(start.getTime() / 1000), end: now }; } },
    { id: 'yesterday', label: 'Yesterday', seconds: () => { const s = new Date(); s.setDate(s.getDate() - 1); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setHours(23, 59, 59, 999); return { start: Math.floor(s.getTime() / 1000), end: Math.floor(e.getTime() / 1000) }; } },
    { id: 'last_7', label: 'Last 7 Days', seconds: () => { const now = Math.floor(Date.now() / 1000); return { start: now - 7 * 86400, end: now }; } },
    { id: 'last_30', label: 'Last 30 Days', seconds: () => { const now = Math.floor(Date.now() / 1000); return { start: now - 30 * 86400, end: now }; } },
    { id: 'all', label: 'All Time', seconds: () => { return { start: 0, end: Math.floor(Date.now() / 1000) }; } },
];

// Offline preview data
const STUB_ACTIVITIES: ActivityEntry[] = [
    { id: 1, appName: 'Visual Studio Code', windowTitle: 'ChatView.tsx - Atheletia', categoryId: 1, startTime: Date.now() / 1000 - 3600, durationSeconds: 2400 },
    { id: 2, appName: 'Google Chrome', windowTitle: 'Atheletia Architecture - GitHub', categoryId: 2, startTime: Date.now() / 1000 - 1200, durationSeconds: 900 },
    { id: 3, appName: 'Spotify', windowTitle: 'Lofi Hip Hop Radio', categoryId: 4, startTime: Date.now() / 1000 - 300, durationSeconds: 300 },
    { id: 4, appName: 'Windows Terminal', windowTitle: 'npm run tauri:dev', categoryId: 1, startTime: Date.now() / 1000 - 7200, durationSeconds: 1800 },
    { id: 5, appName: 'Slack', windowTitle: '# dev-team', categoryId: 3, startTime: Date.now() / 1000 - 5400, durationSeconds: 600 },
    { id: 6, appName: 'Notion', windowTitle: 'Sprint Board — Q1 2026', categoryId: 5, startTime: Date.now() / 1000 - 9000, durationSeconds: 1200 },
];

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatDateTime(ts: number, showDate: boolean): string {
    const d = new Date(ts * 1000);
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (!showDate) return time;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + time;
}

function totalDuration(entries: ActivityEntry[]): string {
    const totalSecs = entries.reduce((acc, e) => acc + e.durationSeconds, 0);
    return formatDuration(totalSecs);
}

function getActivityErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
        return error;
    }
    return fallback;
}

export const ActivityView: React.FC = () => {
    const [allActivities, setAllActivities] = useState<ActivityEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [timeRangeId, setTimeRangeId] = useState('today');
    const [catFilter, setCatFilter] = useState<number | null>(null);
    const [showTimeMenu, setShowTimeMenu] = useState(false);
    const [showCatMenu, setShowCatMenu] = useState(false);

    const selectedRange = TIME_RANGES.find(r => r.id === timeRangeId)!;
    const isMultiDay = ['last_7', 'last_30', 'all'].includes(timeRangeId);

    const load = async (rangeId = timeRangeId) => {
        setLoading(true);
        setLoadError(null);
        try {
            if (window.atheletiaAPI?.intent?.getActivities) {
                const range = TIME_RANGES.find(r => r.id === rangeId)!.seconds();
                const data = await window.atheletiaAPI.intent.getActivities(range.start, range.end, 1000);

                // Map backend snake_case fields -> frontend camelCase fields
                const mappedData: ActivityEntry[] = data.map((d: any) => ({
                    id: d.id,
                    appName: d.app_name || d.appName,
                    windowTitle: d.window_title || d.windowTitle,
                    categoryId: d.category_id || d.categoryId,
                    startTime: d.start_time || d.startTime,
                    durationSeconds: d.duration_seconds || d.durationSeconds,
                }));

                setAllActivities(mappedData);
            } else {
                setAllActivities([]);
                setLoadError('Activity tracking is unavailable in this runtime.');
            }
        } catch (e) {
            console.error('Failed to load activities', e);
            setAllActivities([]);
            setLoadError(`Failed to load activities: ${getActivityErrorMessage(e, 'Unknown error')}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const handleRangeChange = (id: string) => {
        setTimeRangeId(id);
        setShowTimeMenu(false);
        load(id);
    };

    // Filter by category
    const displayed = useMemo(() =>
        catFilter === null
            ? allActivities
            : allActivities.filter(e => e.categoryId === catFilter),
        [allActivities, catFilter]
    );

    // Category breakdown for stats bar
    const catTotals = useMemo(() => {
        const totals: Record<number, number> = {};
        allActivities.forEach(e => { totals[e.categoryId] = (totals[e.categoryId] ?? 0) + e.durationSeconds; });
        return Object.entries(totals)
            .map(([id, secs]) => ({ id: Number(id), secs }))
            .sort((a, b) => b.secs - a.secs);
    }, [allActivities]);

    const totalSecs = allActivities.reduce((a, e) => a + e.durationSeconds, 0);

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-6 md:px-10 pt-2 pb-4">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">Activity</h1>
                    <p className="text-xs text-gray-500">{allActivities.length} events · {totalDuration(allActivities)} total</p>
                </div>
                <div className="flex items-center gap-2">
                    {/* Time range picker */}
                    <div className="relative">
                        <button
                            onClick={() => { setShowTimeMenu(!showTimeMenu); setShowCatMenu(false); }}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#161616] border border-[#262626] text-xs text-gray-400 hover:text-white hover:border-[#333] transition-all"
                        >
                            <Clock size={12} />
                            {selectedRange.label}
                            <ChevronDown size={11} className={`transition-transform ${showTimeMenu ? 'rotate-180' : ''}`} />
                        </button>
                        {showTimeMenu && (
                            <div className="absolute right-0 top-full mt-1 w-40 bg-[#111] border border-[#2a2a2a] rounded-xl shadow-2xl z-dropdown py-1">
                                {TIME_RANGES.map(r => (
                                    <button key={r.id} onClick={() => handleRangeChange(r.id)}
                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-white/5 transition-colors ${timeRangeId === r.id ? 'text-cyan-400' : 'text-gray-300'}`}>
                                        {r.label}
                                        {timeRangeId === r.id && <div className="w-1.5 h-1.5 rounded-full bg-cyan-400" />}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Category filter */}
                    <div className="relative">
                        <button
                            onClick={() => { setShowCatMenu(!showCatMenu); setShowTimeMenu(false); }}
                            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs transition-all ${catFilter !== null ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400' : 'bg-[#161616] border-[#262626] text-gray-400 hover:text-white hover:border-[#333]'}`}
                        >
                            <Filter size={12} />
                            {catFilter !== null ? CATEGORY_META[catFilter]?.label : 'All Categories'}
                            <ChevronDown size={11} className={`transition-transform ${showCatMenu ? 'rotate-180' : ''}`} />
                        </button>
                        {showCatMenu && (
                            <div className="absolute right-0 top-full mt-1 w-48 bg-[#111] border border-[#2a2a2a] rounded-xl shadow-2xl z-dropdown py-1">
                                <button onClick={() => { setCatFilter(null); setShowCatMenu(false); }}
                                    className={`w-full flex items-center px-3 py-2 text-xs hover:bg-white/5 transition-colors ${catFilter === null ? 'text-cyan-400' : 'text-gray-300'}`}>
                                    All Categories
                                </button>
                                {Object.entries(CATEGORY_META).map(([id, meta]) => {
                                    const Icon = meta.icon;
                                    return (
                                        <button key={id} onClick={() => { setCatFilter(Number(id)); setShowCatMenu(false); }}
                                            className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/5 transition-colors ${catFilter === Number(id) ? 'text-cyan-400' : 'text-gray-300'}`}>
                                            <Icon size={12} className={meta.color} />
                                            {meta.label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Refresh */}
                    <button
                        onClick={() => load()}
                        disabled={loading}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#161616] border border-[#262626] text-gray-400 hover:text-white hover:border-[#333] transition-all text-xs"
                    >
                        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                        Refresh
                    </button>
                </div>
            </div>

            {loadError && (
                <div className="px-6 md:px-10 pb-4">
                    <StatusBanner
                        tone="error"
                        title="Activity load failed"
                        message={loadError}
                        action={
                            <button
                                onClick={() => setLoadError(null)}
                                className="rounded-md border border-red-400/30 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/15"
                            >
                                Dismiss
                            </button>
                        }
                    />
                </div>
            )}

            {/* Category breakdown bar */}
            {totalSecs > 0 && catTotals.length > 0 && (
                <div className="px-6 md:px-10 pb-4">
                    <div className="flex h-1.5 rounded-full overflow-hidden gap-px bg-[#111]">
                        {catTotals.map(({ id, secs }) => {
                            const meta = CATEGORY_META[id] ?? CATEGORY_META[7];
                            const pct = (secs / totalSecs) * 100;
                            return (
                                <button
                                    key={id}
                                    title={`${meta.label}: ${formatDuration(secs)}`}
                                    style={{ width: `${pct}%` }}
                                    onClick={() => setCatFilter(catFilter === id ? null : id)}
                                    className={`h-full ${meta.color.replace('text-', 'bg-').replace('-400', '-500')} hover:opacity-80 transition-opacity ${catFilter === id ? 'ring-1 ring-white/30' : ''}`}
                                />
                            );
                        })}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                        {catTotals.slice(0, 5).map(({ id, secs }) => {
                            const meta = CATEGORY_META[id] ?? CATEGORY_META[7];
                            return (
                                <button key={id} onClick={() => setCatFilter(catFilter === id ? null : id)}
                                    className={`flex items-center gap-1.5 text-[10px] transition-opacity ${catFilter !== null && catFilter !== id ? 'opacity-30' : ''}`}>
                                    <div className={`w-2 h-2 rounded-full ${meta.color.replace('text-', 'bg-').replace('-400', '-500')}`} />
                                    <span className="text-gray-400">{meta.label}</span>
                                    <span className="text-gray-600">{formatDuration(secs)}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Timeline */}
            <div className="flex-1 overflow-y-auto px-6 md:px-10 pb-8">
                {displayed.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-gray-600">
                        <Activity size={36} className="mb-3 opacity-40" />
                        <p className="text-sm">No activity data for this range.</p>
                        <p className="text-xs mt-1">Activity tracking starts once the Tauri backend is connected.</p>
                    </div>
                ) : (
                    <div className="relative">
                        {/* Vertical line */}
                        <div className="absolute left-5 top-0 bottom-0 w-px bg-[#1e1e1e]" />

                        <div className="space-y-2 pl-14">
                            {displayed.map((entry) => {
                                const cat = CATEGORY_META[entry.categoryId] ?? CATEGORY_META[7];
                                const CatIcon = cat.icon;
                                const isExpanded = expandedId === entry.id;

                                return (
                                    <div key={entry.id} className="relative">
                                        {/* Timeline dot */}
                                        <div className={`absolute -left-9 top-3.5 w-2.5 h-2.5 rounded-full border-2 border-[#0a0a0a] ${cat.color.replace('text-', 'bg-').replace('-400', '-500')}`} />

                                        <button
                                            onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                                            className="w-full text-left flex items-center gap-4 p-3.5 bg-[#111] border border-[#1e1e1e] rounded-xl hover:border-[#2a2a2a] transition-colors group"
                                        >
                                            {/* Category icon */}
                                            <div className={`w-8 h-8 rounded-lg ${cat.bg} flex items-center justify-center flex-shrink-0`}>
                                                <CatIcon size={15} className={cat.color} />
                                            </div>

                                            {/* Main info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-semibold text-gray-200 truncate">{entry.appName}</p>
                                                <p className="text-xs text-gray-500 truncate mt-0.5">{entry.windowTitle}</p>
                                            </div>

                                            {/* Right: time + duration */}
                                            <div className="flex-shrink-0 text-right">
                                                <p className="text-xs text-gray-400">{formatDateTime(entry.startTime, isMultiDay)}</p>
                                                <p className={`text-xs font-medium mt-0.5 ${cat.color}`}>{formatDuration(entry.durationSeconds)}</p>
                                            </div>

                                            {isExpanded
                                                ? <ChevronUp size={14} className="text-gray-600 flex-shrink-0" />
                                                : <ChevronDown size={14} className="text-gray-600 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                            }
                                        </button>

                                        {isExpanded && (
                                            <div className="mt-1 p-3.5 bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl space-y-2">
                                                <div className="flex items-center gap-2 text-xs text-gray-500">
                                                    <Clock size={12} />
                                                    <span>{formatDateTime(entry.startTime, true)}</span>
                                                    <span className="text-gray-700">·</span>
                                                    <span>Duration: {formatDuration(entry.durationSeconds)}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className={`flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full ${cat.bg} ${cat.color} font-semibold uppercase tracking-wider`}>
                                                        <CatIcon size={9} />
                                                        {cat.label}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-gray-400 leading-relaxed">{entry.windowTitle}</p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
