import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { ChatMessage as ChatMessageType, AgentStep, ActivityRef } from '../../lib/chatTypes';
import { formatTime } from '../../lib/chatUtils';
import { sanitizeAiVisibleText, VISUALIZE_INFO_RE } from '../../lib/aiText';
import { VisualizeBlock } from '../VisualizeBlock';
import { MermaidBlock } from '../MermaidBlock';
import {
    ChevronDown,
    ChevronRight,
    Wrench,
    Music,
    Monitor,
    Clock,
    Brain,
    Search,
    BarChart2,
    Database,
    FileText,
    Zap,
    User,
    Bot,
} from 'lucide-react';

interface ChatMessageProps {
    message: ChatMessageType;
    isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
    const [showSteps, setShowSteps] = useState(false);
    const [showAllActivities, setShowAllActivities] = useState(false);
    const [showThinking, setShowThinking] = useState(false);
    const [displayedText, setDisplayedText] = useState('');
    const isUser = message.role === 'user';
    const hasSteps = message.tool_calls && message.tool_calls.length > 0;
    const hasActivities = message.activities && message.activities.length > 0;
    const { answerText, thinkingText } = splitThinkingContent(message.content);
    const hasThinking = false;
    const rawAssistant = isUser ? message.content : cleanAssistantContent(answerText || message.content);
    const bubbleText = isUser ? rawAssistant : stripLeadingChainOfThought(rawAssistant).trim();

    // Auto-expand steps if there are only a few
    const autoExpand = hasSteps && message.tool_calls!.length <= 3;
    useEffect(() => {
        if (autoExpand) setShowSteps(true);
    }, [autoExpand]);

    useEffect(() => {
        if (hasThinking && isStreaming) {
            setShowThinking(true);
        }
    }, [hasThinking, isStreaming]);

    useEffect(() => {
        if (!isStreaming || isUser) {
            setDisplayedText(bubbleText);
            return;
        }

        const timer = window.setInterval(() => {
            setDisplayedText((prev) => {
                if (!bubbleText.startsWith(prev)) return bubbleText;
                if (prev.length >= bubbleText.length) return prev;
                return bubbleText.slice(0, prev.length + 1);
            });
        }, 8);

        return () => window.clearInterval(timer);
    }, [bubbleText, isStreaming, isUser]);

    const visibleActivities = showAllActivities
        ? message.activities!
        : message.activities?.slice(0, 10);
    const streamingPlaceholder = !isUser && isStreaming && !bubbleText && hasThinking ? 'Thinking...' : '';
    const messageText = isStreaming && !isUser ? (displayedText || streamingPlaceholder) : bubbleText;

    return (
        <div
            className={`flex gap-3 mb-6 ${isUser ? 'justify-end' : 'justify-start'}`}
            style={{ animation: 'msgFadeIn 0.25s ease-out' }}
        >
            {/* Avatar — assistant only */}
            {!isUser && (
                <div className="flex-shrink-0 mt-1">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-cyan-500/30 to-purple-500/30 border border-cyan-500/30 flex items-center justify-center">
                        <Bot className="w-3.5 h-3.5 text-cyan-400" />
                    </div>
                </div>
            )}

            <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[85%]`}>

                {/* Hidden model reasoning is intentionally not rendered. */}
                {false && hasThinking && (
                    <div className="mb-1.5 w-full">
                        <button
                            onClick={() => setShowThinking((prev) => !prev)}
                            className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors px-1"
                        >
                            {showThinking ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            <Brain className="w-3 h-3 text-purple-400/70" />
                            <span className="italic">Reasoned through the answer</span>
                        </button>
                        {showThinking && (
                            <div className="mt-1 ml-1 max-w-[520px] rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs italic leading-relaxed text-gray-400 whitespace-pre-wrap">
                                {thinkingText}
                            </div>
                        )}
                    </div>
                )}

                {/* Message bubble */}
                {isUser ? (
                    <div className="relative rounded-2xl rounded-br-sm px-4 py-3"
                        style={{
                            background: 'linear-gradient(135deg, #0891b2 0%, #0e7490 100%)',
                            boxShadow: '0 2px 12px rgba(8,145,178,0.25)',
                        }}
                    >
                        <p className="text-sm text-white leading-relaxed whitespace-pre-wrap">{bubbleText}</p>
                    </div>
                ) : (
                    <div
                        className="relative rounded-2xl rounded-bl-sm px-4 py-3.5"
                        style={{
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            boxShadow: '0 2px 16px rgba(0,0,0,0.4)',
                            backdropFilter: 'blur(8px)',
                        }}
                    >
                        <MarkdownMessage text={messageText} />
                        {isStreaming && !isUser && (
                            <span className="inline-block w-[5px] h-[14px] ml-0.5 align-[-2px] rounded-sm bg-cyan-400/80 animate-pulse" />
                        )}
                    </div>
                )}

                {/* Agent steps — vertical timeline */}
                {hasSteps && (
                    <div className="mt-3 w-full">
                        <button
                            onClick={() => setShowSteps(!showSteps)}
                            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-200 transition-colors group mb-2"
                        >
                            <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-full px-2.5 py-1 group-hover:border-white/20 transition-all">
                                <Zap className="w-3 h-3 text-amber-400" />
                                <span className="font-medium">{message.tool_calls!.length} agent step{message.tool_calls!.length > 1 ? 's' : ''}</span>
                                {showSteps
                                    ? <ChevronDown className="w-3 h-3 ml-0.5" />
                                    : <ChevronRight className="w-3 h-3 ml-0.5" />
                                }
                            </div>
                        </button>

                        {showSteps && (
                            <div className="relative pl-5 space-y-2">
                                {/* vertical line */}
                                <div className="absolute left-2 top-2 bottom-2 w-px bg-gradient-to-b from-cyan-500/40 via-purple-500/20 to-transparent" />
                                {message.tool_calls!.map((step, i) => (
                                    <AgentStepCard key={i} step={step} index={i} total={message.tool_calls!.length} />
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Activity references */}
                {hasActivities && (
                    <div className="mt-3 w-full">
                        <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-widest mb-2 px-0.5">
                            Referenced Activities
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {visibleActivities!.map((act, i) => (
                                <ActivityCard key={i} activity={act} />
                            ))}
                        </div>
                        {message.activities!.length > 10 && (
                            <button
                                onClick={() => setShowAllActivities(!showAllActivities)}
                                className="mt-2 text-[11px] text-cyan-400/70 hover:text-cyan-400 transition-colors"
                            >
                                {showAllActivities
                                    ? '↑ Show fewer'
                                    : `+${message.activities!.length - 10} more activities`
                                }
                            </button>
                        )}
                    </div>
                )}

                {/* Timestamp */}
                <p className={`text-[10px] mt-1.5 px-0.5 ${isUser ? 'text-cyan-300/50' : 'text-gray-600'}`}>
                    {formatTime(message.created_at)}
                </p>
            </div>

            {/* Avatar — user only */}
            {isUser && (
                <div className="flex-shrink-0 mt-1">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-cyan-600 to-blue-700 flex items-center justify-center">
                        <User className="w-3.5 h-3.5 text-white" />
                    </div>
                </div>
            )}

            <style>{`
                @keyframes msgFadeIn {
                    from { opacity: 0; transform: translateY(6px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
}

function MarkdownMessage({ text }: { text: string }) {
    const normalizedText = text.replace(/```html[ \t]+visualize/gi, '```visualize-html');
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={{
                h1: ({ children }) => (
                    <h1 className="text-base font-bold mt-3 mb-1.5 text-white border-l-2 border-cyan-500 pl-2.5">
                        {children}
                    </h1>
                ),
                h2: ({ children }) => (
                    <h2 className="text-sm font-semibold mt-3 mb-1.5 text-white border-l-2 border-purple-500/70 pl-2.5">
                        {children}
                    </h2>
                ),
                h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 text-gray-100">{children}</h3>,
                h4: ({ children }) => <h4 className="text-sm font-medium mt-1.5 mb-1 text-gray-200">{children}</h4>,
                h5: ({ children }) => <h5 className="text-sm font-medium mt-1 mb-0.5 text-gray-300">{children}</h5>,
                h6: ({ children }) => <h6 className="text-xs font-medium mt-1 mb-0.5 text-gray-400">{children}</h6>,
                p: ({ children }) => (
                    <p className="text-sm leading-relaxed text-gray-200 whitespace-pre-wrap mb-2 last:mb-0">{children}</p>
                ),
                ul: ({ children }) => <ul className="list-none pl-0 text-sm my-1.5 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 text-sm my-1.5 space-y-1 text-gray-200">{children}</ol>,
                li: ({ children }) => (
                    <li className="flex gap-2 items-start text-gray-200 leading-relaxed">
                        <span className="mt-2 w-1.5 h-1.5 rounded-full bg-cyan-500/60 flex-shrink-0" />
                        <span>{children}</span>
                    </li>
                ),
                a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer" className="text-cyan-400 underline decoration-cyan-400/40 hover:text-cyan-300 hover:decoration-cyan-300/60 transition-colors">
                        {children}
                    </a>
                ),
                strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                em: ({ children }) => <em className="italic text-gray-300">{children}</em>,
                code: ({ className, children, ...props }) => {
                    const isBlock = !!className;
                    const lang = className?.replace('language-', '') ?? '';
                    const codeText = flattenReactNodeText(children).replace(/\n$/, '');
                    if (isBlock && (VISUALIZE_INFO_RE.test(lang) || lang === 'visualize-html')) {
                        return <VisualizeBlock html={codeText} />;
                    }
                    const mermaidChart = extractMermaidChart(codeText, className);
                    if (mermaidChart) {
                        return <MermaidBlock chart={mermaidChart} />;
                    }
                    if (isBlock) {
                        return (
                            <code className="block text-xs text-gray-100 whitespace-pre-wrap font-mono" data-lang={lang} {...props as object}>
                                {children}
                            </code>
                        );
                    }
                    return (
                        <code className="px-1.5 py-0.5 rounded-md bg-black/40 border border-white/10 text-xs text-emerald-300 font-mono" {...props as object}>
                            {children}
                        </code>
                    );
                },
                pre: ({ children }) => {
                    const { className, codeText } = extractPreCodePayload(children);
                    const lang = className?.replace('language-', '') ?? '';
                    if (VISUALIZE_INFO_RE.test(lang) || lang === 'visualize-html') {
                        return <VisualizeBlock html={codeText} />;
                    }
                    const mermaidChart = extractMermaidChart(codeText, className);
                    if (mermaidChart) {
                        return <MermaidBlock chart={mermaidChart} />;
                    }
                    return (
                        <div className="relative my-2.5 group">
                            <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-cyan-500/5 to-purple-500/5 pointer-events-none" />
                            <pre className="text-xs bg-black/50 border border-white/10 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                                {children}
                            </pre>
                        </div>
                    );
                },
                table: ({ children }) => (
                    <div className="overflow-x-auto my-3 rounded-xl border border-white/10">
                        <table className="min-w-full text-xs">{children}</table>
                    </div>
                ),
                thead: ({ children }) => <thead className="bg-white/5">{children}</thead>,
                th: ({ children }) => (
                    <th className="px-3 py-2 text-left border-b border-white/10 font-semibold text-gray-200 text-[11px] uppercase tracking-wide">
                        {children}
                    </th>
                ),
                td: ({ children }) => (
                    <td className="px-3 py-2 align-top border-b border-white/5 text-gray-300 even:bg-white/[0.02]">
                        {children}
                    </td>
                ),
                blockquote: ({ children }) => (
                    <blockquote className="border-l-[3px] border-cyan-500/50 pl-3.5 my-2 bg-cyan-500/5 rounded-r-lg py-2 italic text-gray-300">
                        {children}
                    </blockquote>
                ),
                hr: () => <hr className="border-white/10 my-3" />,
            }}
        >
            {normalizedText}
        </ReactMarkdown>
    );
}

function flattenReactNodeText(node: React.ReactNode): string {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flattenReactNodeText).join('');
    if (React.isValidElement(node)) return flattenReactNodeText((node.props as { children?: React.ReactNode }).children);
    return '';
}

function normalizeMermaidChart(input: string): string {
    let text = (input || '').replace(/\r\n/g, '\n').trim();
    if (!text) return '';

    const fencedWithLang = text.match(/^```\s*mermaid\s*\n([\s\S]*?)\n```$/i);
    if (fencedWithLang?.[1]) {
        text = fencedWithLang[1].trim();
    } else {
        text = text
            .replace(/^```\s*mermaid\s*\n?/i, '')
            .replace(/^mermaid\s*\n/i, '')
            .replace(/\n?```$/i, '')
            .trim();
    }

    return text;
}

function firstMermaidDirectiveLine(input: string): string {
    const normalized = normalizeMermaidChart(input);
    if (!normalized) return '';

    const lines = normalized.split('\n').map(line => line.trim());
    for (const line of lines) {
        if (!line || line.startsWith('%%')) continue;
        return line;
    }

    return '';
}

function looksLikeMermaid(input: string): boolean {
    const firstLine = firstMermaidDirectiveLine(input);
    return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|architecture|block-beta)\b/i.test(firstLine);
}

function extractMermaidChart(codeText: string, className?: string): string | null {
    const normalized = normalizeMermaidChart(codeText);
    if (!normalized) return null;

    if (className?.includes('language-mermaid') || looksLikeMermaid(normalized)) {
        return normalized;
    }

    return null;
}

function extractPreCodePayload(children: React.ReactNode): { className: string; codeText: string } {
    const childNodes = React.Children.toArray(children);
    const codeChild = childNodes.find(node => React.isValidElement(node));

    if (codeChild && React.isValidElement<{ className?: string; children?: React.ReactNode }>(codeChild)) {
        return {
            className: codeChild.props.className || '',
            codeText: flattenReactNodeText(codeChild.props.children),
        };
    }

    return {
        className: '',
        codeText: flattenReactNodeText(children),
    };
}

// ─── Tool icon & color map ───

function toolMeta(name: string): { icon: React.ReactNode; color: string; label: string } {
    switch (name) {
        case 'get_recent_activities':
        case 'query_activities':
            return { icon: <Clock className="w-3.5 h-3.5" />, color: '#60a5fa', label: 'Activities' };
        case 'search_ocr':
        case 'get_recent_ocr':
            return { icon: <Monitor className="w-3.5 h-3.5" />, color: '#34d399', label: 'Screen Text' };
        case 'get_usage_stats':
            return { icon: <BarChart2 className="w-3.5 h-3.5" />, color: '#fbbf24', label: 'Usage Stats' };
        case 'get_music_history':
            return { icon: <Music className="w-3.5 h-3.5" />, color: '#a78bfa', label: 'Music' };
        case 'get_recent_file_changes':
            return { icon: <FileText className="w-3.5 h-3.5" />, color: '#f97316', label: 'File Changes' };
        case 'parallel_search':
            return { icon: <Search className="w-3.5 h-3.5" />, color: '#e879f9', label: 'Parallel Search' };
        case 'resolve_query_scope':
            return { icon: <Zap className="w-3.5 h-3.5" />, color: '#fb923c', label: 'Scope Update' };
        default:
            return { icon: <Database className="w-3.5 h-3.5" />, color: '#94a3b8', label: name };
    }
}

function AgentStepCard({ step, index, total }: { step: AgentStep; index: number; total: number }) {
    const [expanded, setExpanded] = useState(false);
    const { icon, color, label } = toolMeta(step.tool_name);

    const resultSummary = () => {
        if (!step.tool_result) return 'No result';
        try {
            const data = JSON.parse(step.tool_result);
            if (Array.isArray(data)) return `${data.length} result${data.length !== 1 ? 's' : ''}`;
            return 'Data received';
        } catch {
            const lines = step.tool_result.trim().split('\n');
            const firstLine = lines[0]?.trim() || '';
            return firstLine.length > 70 ? firstLine.slice(0, 70) + '…' : firstLine;
        }
    };

    return (
        <div className="relative">
            {/* timeline dot */}
            <div
                className="absolute -left-[17px] top-3 w-2.5 h-2.5 rounded-full border-2 border-[#111] z-10"
                style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}44` }}
            />
            <div
                className="rounded-xl overflow-hidden border transition-all"
                style={{ borderColor: expanded ? `${color}33` : 'rgba(255,255,255,0.07)' }}
            >
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/[0.04] transition-colors"
                    style={{ background: expanded ? `${color}08` : 'transparent' }}
                >
                    <span style={{ color }}>{icon}</span>
                    <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-gray-200">{label}</span>
                        <span className="text-[11px] text-gray-500 ml-2">→ {resultSummary()}</span>
                    </div>
                    {/* Step number badge */}
                    <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 mr-1"
                        style={{ color, background: `${color}18` }}>
                        {index + 1}/{total}
                    </span>
                    {expanded
                        ? <ChevronDown className="w-3 h-3 text-gray-500 flex-shrink-0" />
                        : <ChevronRight className="w-3 h-3 text-gray-500 flex-shrink-0" />
                    }
                </button>

                {expanded && (
                    <div className="px-3 pb-3 space-y-2.5 border-t border-white/5">
                        {step.reasoning && (
                            <div className="mt-2.5">
                                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Reasoning</p>
                                <p className="text-xs text-gray-300 italic leading-relaxed">{step.reasoning}</p>
                            </div>
                        )}
                        <div>
                            <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Arguments</p>
                            <pre className="text-[11px] text-gray-300 bg-black/40 rounded-lg p-2.5 overflow-x-auto font-mono">
                                {JSON.stringify(step.tool_args, null, 2)}
                            </pre>
                        </div>
                        <div>
                            <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Result</p>
                            <pre className="text-[11px] text-gray-300 bg-black/40 rounded-lg p-2.5 overflow-x-auto max-h-48 overflow-y-auto font-mono">
                                {(() => {
                                    try { return JSON.stringify(JSON.parse(step.tool_result), null, 2); }
                                    catch { return step.tool_result; }
                                })()}
                            </pre>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function appColor(app: string): string {
    const a = app.toLowerCase();
    if (a.includes('vs code') || a.includes('visual studio') || a.includes('cursor')) return '#60a5fa';
    if (a.includes('brave') || a.includes('chrome') || a.includes('firefox') || a.includes('browser')) return '#f97316';
    if (a.includes('spotify')) return '#22c55e';
    if (a.includes('whatsapp')) return '#34d399';
    if (a.includes('youtube')) return '#ef4444';
    if (a.includes('obsidian')) return '#a78bfa';
    if (a.includes('notion')) return '#94a3b8';
    if (a.includes('terminal') || a.includes('powershell') || a.includes('cmd')) return '#fbbf24';
    return '#94a3b8';
}

function ActivityCard({ activity }: { activity: ActivityRef }) {
    const hasMedia = activity.media && activity.media.title;
    const color = hasMedia ? '#a78bfa' : appColor(activity.app || '');

    return (
        <div
            className="flex items-center gap-2 rounded-xl px-3 py-1.5 transition-all cursor-pointer group"
            style={{
                background: `${color}0d`,
                border: `1px solid ${color}25`,
                boxShadow: `0 1px 6px ${color}10`,
            }}
            onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.background = `${color}1a`;
                (e.currentTarget as HTMLDivElement).style.borderColor = `${color}40`;
                (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.background = `${color}0d`;
                (e.currentTarget as HTMLDivElement).style.borderColor = `${color}25`;
                (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
            }}
        >
            {hasMedia ? (
                <Music className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} />
            ) : (
                <Monitor className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} />
            )}
            <div className="min-w-0">
                <p className="text-xs font-medium truncate max-w-[180px]" style={{ color: '#e2e8f0' }}>
                    {hasMedia
                        ? `${activity.media!.title}`
                        : activity.title || activity.app}
                </p>
                <p className="text-[10px] truncate max-w-[180px]" style={{ color: '#64748b' }}>
                    {hasMedia
                        ? `${activity.media!.artist || ''} · ${activity.app}`
                        : `${activity.app} · ${formatTime(activity.time)}`
                    }
                </p>
            </div>
        </div>
    );
}

// ─── Content processing helpers (unchanged) ───

function cleanAssistantContent(content: string): string {
    let text = content.replace(/^\[Agent\].*/gim, '');
    text = text
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '');
    const tail = extractAnswerTailFromContent(text);
    if (tail.trim()) {
        text = tail;
    } else {
        text = stripToolJsonPayloads(text);
    }
    text = stripReasoningLeaks(text);
    text = sanitizeAiVisibleText(text);
    text = text.replace(/<th\*{0,4}Answer[^>]*>/gi, '').replace(/<\/th>/gi, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

function extractAnswerTailFromContent(content: string): string {
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastClosedAt = -1;
    let foundToolBlock = false;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { depth++; continue; }
        if (ch === '}') {
            if (depth > 0) {
                depth--;
                if (depth === 0) {
                    const block = content.slice(content.lastIndexOf('{', i), i + 1);
                    if (block.includes('"tool"') || block.includes('"args"')) {
                        foundToolBlock = true;
                        lastClosedAt = i;
                    }
                }
            }
            continue;
        }
    }

    if (!foundToolBlock || lastClosedAt < 0) return '';
    return content.slice(lastClosedAt + 1).replace(/^[\s,\[\]]+/, '').trim();
}

function splitThinkingContent(content: string): { answerText: string; thinkingText: string } {
    let answerText = content;
    let thinkingText = '';

    const thinkRegex = /<think[^>]*>([\s\S]*?)<\/think>/gi;
    let match;

    while ((match = thinkRegex.exec(content)) !== null) {
        thinkingText += match[1] + '\n';
        answerText = answerText.replace(match[0], '');
    }

    const unclosedThinkRegex = /<think[^>]*>([\s\S]*)$/i;
    const unclosedMatch = unclosedThinkRegex.exec(answerText);
    if (unclosedMatch) {
        thinkingText += unclosedMatch[1] + '\n';
        answerText = answerText.replace(unclosedMatch[0], '');
    }

    return {
        answerText: stripToolJsonPayloads(answerText).trim(),
        thinkingText: sanitizeThinkingText(thinkingText.trim()),
    };
}

function sanitizeThinkingText(raw: string): string {
    let text = raw
        .replace(/\[TOOL_CALL[^\]]*\][\s\S]*/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
        .replace(/^\[Agent\].*/gim, '')
        .trim();
    if (!text) return '';

    const looksLikeToolJson =
        (text.includes('"tool"') || text.includes('"tool":')) &&
        (text.includes('"args"') || text.includes('"args":'));
    const looksLikeRawJson =
        /^\s*\{/.test(text) && (text.includes('"tool') || text.includes('"args'));
    if (looksLikeToolJson || looksLikeRawJson) {
        const reasoningMatch = text.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (reasoningMatch?.[1]?.trim()) return reasoningMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
        return '';
    }

    const candidate = extractJsonObject(text) || text;
    try {
        const parsed = JSON.parse(candidate) as { tool?: string; args?: unknown; reasoning?: string };
        if (parsed && typeof parsed === 'object' && parsed.tool && parsed.args) {
            if (typeof parsed.reasoning === 'string' && parsed.reasoning.trim()) {
                return parsed.reasoning.trim();
            }
            return '';
        }
    } catch { }

    const compact = text.replace(/\bThinking\.\.\.\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
    if (!compact) return '';
    const lower = compact.toLowerCase();
    const looksInternal =
        lower.includes('the user ') || lower.includes('user says') ||
        lower.includes('i should') || lower.includes('let me ') ||
        lower.includes('likely they') || lower.includes('we need to') ||
        lower.includes('then we') || lower.includes("let's call") ||
        lower.includes('tool output') || lower.includes('call get_') ||
        lower.includes('reasoning models');
    if (looksInternal) return 'Analyzing your request and checking the relevant activity data.';
    const firstSentence = compact.split(/(?<=[.!?])\s+/)[0]?.trim() || compact;
    return firstSentence.slice(0, 180);
}

function extractJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return text.slice(start, end + 1);
    return null;
}

function stripToolJsonPayloads(text: string): string {
    let result = text;
    result = result.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, (match, content) => {
        if (content.includes('"tool"') && content.includes('"args"')) return '';
        return match;
    });

    let cleaned = '';
    let depth = 0;
    let startIdx = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < result.length; i++) {
        const char = result[i];
        if (inString) {
            if (escape) { escape = false; }
            else if (char === '\\') { escape = true; }
            else if (char === '"') { inString = false; }
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '{') {
            if (depth === 0) { cleaned += result.slice(startIdx, i); startIdx = i; }
            depth++;
            continue;
        }
        if (char === '}') {
            if (depth > 0) {
                depth--;
                if (depth === 0) {
                    const objStr = result.slice(startIdx, i + 1);
                    if (!(objStr.includes('"tool"') && objStr.includes('"args"'))) cleaned += objStr;
                    startIdx = i + 1;
                }
            }
            continue;
        }
    }

    if (startIdx < result.length) {
        const leftover = result.slice(startIdx);
        if (!(depth > 0 && leftover.includes('"tool"'))) cleaned += leftover;
    }

    result = cleaned;
    result = result.replace(/^[\s\[\],]+$/g, '');
    result = result.replace(/\[\s*(?:,\s*)*\]/g, '');
    result = result.replace(/,\s*(?=\])/g, '');
    result = result.replace(/^,\s*/g, '');

    return result
        .replace(/<\|tool_calls_section_begin\|>/gi, '')
        .replace(/<\|tool_calls_section_end\|>/gi, '')
        .replace(/<\|tool_call_begin\|>/gi, '')
        .replace(/<\|tool_call_end\|>/gi, '')
        .replace(/<\|tool_call_argument_begin\|>/gi, '')
        .replace(/\[\[IF_ACTION:\{[\s\S]*?\}\]\]/gi, '')
        .replace(/<think[^>]*>/gi, '')
        .replace(/<\/think>/gi, '')
        .replace(/\[TOOL_CALL[^\]]*\].*/gim, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripReasoningLeaks(text: string): string {
    let result = text;
    result = result.replace(/,?\s*"reasoning"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}?/gs, '');
    result = result.replace(/^\s*,\s*"[a-zA-Z_]+"\s*:\s*(?:"[^"]*"|true|false|\d+)\s*\}?\s*$/gm, '');
    result = result.replace(/^\s*\}\s*$/gm, '');
    result = result.replace(/<\|(?:tool_calls?|function)[^|]*\|>/gi, '');
    result = result.replace(/\n{3,}/g, '\n\n');
    result = stripLeadingChainOfThought(result);
    return result.trim();
}

function stripLeadingChainOfThought(text: string): string {
    const sentenceReasoningPatterns = [
        /^the user (just |has )?(said|says|asked|wants|is |sent)/i,
        /^no (question|tool calls?|function calls?|action)\b/i,
        /^(we|i) should (respond|reply|say|answer|just)/i,
        /^this (is a simple|is straightforward|requires? no|is not a)/i,
        /^let me (think|consider|check|look)/i,
        /^since (the user|there|no )/i,
        /^(there are no|there's no) (tool calls?|function calls?|question)/i,
        /^simply (respond|reply|say)/i,
        /^just (respond|reply|say|answer)/i,
        /^no need to (call|use|invoke)/i,
        /^(this doesn't?|it doesn't?) (require|need)/i,
    ];

    const paragraphReasoningPatterns = [
        /^(we|i) (have|found|see|can see|note|know|checked|searched)/i,
        /^(we|i) should/i,
        /^(we|i) (need|want|will|must)/i,
        /^the (evidence|data|result|ocr|activity|context|snippet|search)/i,
        /^(looking|searching|checking|scanning|analyzing|reviewing) /i,
        /^provide (evidence|a bullet|the bullet|an answer)/i,
        /^also (note|remember|verify|check)/i,
        /^(so|therefore|thus),? (we|i|the answer|it)/i,
        /^thus (answer|the answer|we can)/i,
        /^entry \d/i,
        /^(relevant|strong|high) (evidence|confidence|match)/i,
        /^based on (the|this|our|that)/i,
        /^(it (seems|looks|appears)|this means|this indicates)/i,
        /^let('?s| me) (also|now|check|verify|look)/i,
    ];

    const paragraphs = text.split(/\n{2,}/);
    let stripParaUntil = 0;
    for (let i = 0; i < paragraphs.length - 1; i++) {
        const para = paragraphs[i].trim();
        if (paragraphReasoningPatterns.some((p) => p.test(para))) {
            stripParaUntil = i + 1;
        } else {
            break;
        }
    }
    let result = stripParaUntil > 0
        ? paragraphs.slice(stripParaUntil).join('\n\n').trim()
        : text;

    result = result.replace(/^(?:thus answer[.:!]?|so(?:,| the)? answer(?:\s*is)?[.:!]?)\s*/i, '');

    const parts = result.split(/(?<=[.!?]) *(?=[A-Z*\[#\n])/);
    let stripUntil = 0;
    for (let i = 0; i < parts.length - 1; i++) {
        const sentence = parts[i].trim();
        if (sentenceReasoningPatterns.some((p) => p.test(sentence))) {
            stripUntil = i + 1;
        } else {
            break;
        }
    }
    if (stripUntil > 0) {
        result = parts.slice(stripUntil).join(' ').trim();
    }

    return result;
}
