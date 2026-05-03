import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ChatSession, ChatMessage as ChatMessageType, ChatSourceId } from '../../lib/chatTypes';
import {
    createChatSession,
    getChatSessions,
    deleteChatSession,
    getChatMessages,
    sendChatMessage,
    getNvidiaModels,
    getLMStudioModels,
    type ModelInfo,
    ChatServiceError,
} from '../../services/chatService';
import { ChatMessage } from './ChatMessage';
import {
    Send,
    Loader2,
    Bot,
    Sparkles,
    ChevronDown,
    Grid3X3,
    Calendar,
    Check,
    Plus,
    Trash2,
    MessageSquare,
    PanelLeftClose,
    PanelLeft,
    Cloud,
    Cpu,
    RefreshCw,
    Zap,
    Clock,
    BarChart2,
    Star,
    Sun,
    Calendar as CalendarIcon,
    SlidersHorizontal,
    AlertCircle,
    Brain,
    Leaf,
    BriefcaseBusiness,
    Search,
    Square,
    Undo2,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { useFavoriteModels } from '../../hooks/useFavoriteModels';
import { useIntentStore } from '../../store/useIntentStore';
import { useMultiProviderModels, setStoredModelWithProvider, getStoredModelWithProvider } from '../../hooks/useMultiProviderModels';
import { getProviderKey, resolveProviderForModel } from '../../lib/modelFetch';

// Source options
const SOURCE_OPTIONS: Array<{ id: ChatSourceId; label: string; default: boolean }> = [
    { id: 'apps', label: 'Applications', default: true },
    { id: 'screen', label: 'Screen Text (OCR)', default: true },
    { id: 'media', label: 'Media / Music', default: true },
    { id: 'browser', label: 'Browser History', default: false },
    { id: 'files', label: 'Files & Documents', default: false },
];

const CHAT_SOURCE_IDS = new Set<ChatSourceId>(SOURCE_OPTIONS.map((source) => source.id));

const normalizeChatSources = (sources?: string[]): ChatSourceId[] =>
    (sources || []).filter((source): source is ChatSourceId => CHAT_SOURCE_IDS.has(source as ChatSourceId));

// Time range options
const TIME_RANGE_OPTIONS = [
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'last_3_days', label: 'Last 3 Days' },
    { id: 'last_7_days', label: 'Last 7 Days' },
    { id: 'last_30_days', label: 'Last 30 Days' },
    { id: 'this_year', label: 'This Year' },
    { id: 'all_time', label: 'All Time' },
];

// Quick suggestion cards for the empty state
const SUGGESTION_CARDS = [
    {
        icon: Sun,
        label: 'Morning Brief',
        prompt: 'Everything to kickstart your day',
        color: 'text-yellow-500',
        bg: 'bg-[#0a0a0a] border-[#262626]',
    },
    {
        icon: Calendar,
        label: 'Standup Update',
        prompt: 'What you did, what\'s next, any blockers',
        color: 'text-emerald-500',
        bg: 'bg-[#0a0a0a] border-[#262626]',
    },
    {
        icon: SlidersHorizontal,
        label: 'Custom Summary',
        prompt: 'Custom time, filters & instructions',
        color: 'text-purple-500',
        bg: 'bg-[#0a0a0a] border-[#262626]',
    },
    {
        icon: AlertCircle,
        label: 'Top of Mind',
        prompt: 'Recurring topics ranked by importance',
        color: 'text-red-500',
        bg: 'bg-[#0a0a0a] border-[#262626]',
    },
    {
        icon: Brain,
        label: 'AI Habits',
        prompt: 'AI usage patterns and model preferences',
        color: 'text-purple-400',
        bg: 'bg-[#0a0a0a] border-[#262626]',
    },
    {
        icon: Leaf,
        label: 'Discover',
        prompt: 'Reminders, Recaps, and More',
        color: 'text-emerald-400',
        bg: 'bg-[#0a0a0a] border-[#262626]',
    },
];

interface ChatPageProps {
    initialPrompt?: string;
}

const CHAT_MODEL_STORAGE_KEY = 'atheletia_chat_selected_model';

interface ConfirmActionPayload {
    kind: string;
    reason: string;
    suggested_time_range?: string;
    enable_sources?: ChatSourceId[];
    retry_message: string;
}

interface ParsedAssistantAction {
    cleanedContent: string;
    action: ConfirmActionPayload | null;
}

function parseAssistantAction(content: string): ParsedAssistantAction {
    const marker = /\[\[IF_ACTION:(\{[\s\S]*\})\]\]/m;
    const match = content.match(marker);
    if (!match) return { cleanedContent: content, action: null };
    let action: ConfirmActionPayload | null = null;
    try {
        action = JSON.parse(match[1]) as ConfirmActionPayload;
    } catch {
        action = null;
    }
    const cleanedContent = content.replace(marker, '').trim();
    return { cleanedContent, action };
}

function loadSelectedModelFromStorage(): string {
    try {
        const val = localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
        if (val) return val;
        // Migration from previous brands
        const previousBrandModel = localStorage.getItem('allentire_chat_selected_model');
        const previousPrototypeModel = localStorage.getItem('intentflow_chat_selected_model');
        const legacy = previousBrandModel || previousPrototypeModel;
        if (legacy) {
            localStorage.setItem(CHAT_MODEL_STORAGE_KEY, legacy);
            localStorage.removeItem('allentire_chat_selected_model');
            localStorage.removeItem('intentflow_chat_selected_model');
            return legacy;
        }
        return '';
    } catch {
        return '';
    }
}

function extractThinkingBlocks(content: string): string {
    const matches = content.match(/<think[^>]*>[\s\S]*?(?:<\/think>|$)/gi);
    return matches ? matches.join('\n\n').trim() : '';
}

function mergeStreamThinkingIntoContent(content: string, streaming: string): string {
    const thinkingBlocks = extractThinkingBlocks(streaming);
    if (!thinkingBlocks) return content;
    if (/<think[^>]*>/i.test(content)) return content;
    return `${thinkingBlocks}\n\n${content}`.trim();
}

/** Returns all text that comes after the last complete JSON tool-call block. */
function extractAnswerTail(content: string): string {
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastClosedAt = -1;

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
                if (depth === 0) lastClosedAt = i;
            }
            continue;
        }
    }

    if (lastClosedAt < 0) return content; // no JSON block found — all text
    const tail = content.slice(lastClosedAt + 1).replace(/^[\s,\[\]]+/, '').trim();
    return tail;
}

export function ChatPage({ initialPrompt }: ChatPageProps) {
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessageType[]>([]);
    const [input, setInput] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [streamingContent, setStreamingContent] = useState('');
    const [agentStatus, setAgentStatus] = useState('');
    const [displayedStatus, setDisplayedStatus] = useState('');
    const [showHistory, setShowHistory] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const initialPromptHandled = useRef(false);
    const streamingContentRef = useRef('');
    const abortControllerRef = useRef<AbortController | null>(null);
    const activeRequestIdRef = useRef<number>(0);
    const stoppedRequestIdsRef = useRef<Set<number>>(new Set());

    // Dropdown states
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [showSourcesDropdown, setShowSourcesDropdown] = useState(false);
    const [showTimeDropdown, setShowTimeDropdown] = useState(false);
    const [selectedSources, setSelectedSources] = useState<ChatSourceId[]>(
        SOURCE_OPTIONS.filter((s) => s.default).map((s) => s.id)
    );
    const [selectedTimeRange, setSelectedTimeRange] = useState('today');
    const [selectedModel, setSelectedModel] = useState<string>(() => getStoredModelWithProvider(CHAT_MODEL_STORAGE_KEY)?.model || loadSelectedModelFromStorage());
    const [selectedProvider, setSelectedProvider] = useState<string>(() => getStoredModelWithProvider(CHAT_MODEL_STORAGE_KEY)?.provider || '');
    const [pendingAction, setPendingAction] = useState<ConfirmActionPayload | null>(null);

    // Cloud vs Local toggle
    const [modelMode, setModelMode] = useState<'cloud' | 'local'>('cloud');
    const [lmStudioModels, setLmStudioModels] = useState<ModelInfo[]>([]);
    const [lmStudioLoading, setLmStudioLoading] = useState(false);
    const [lmStudioError, setLmStudioError] = useState<string | null>(null);
    const [modelSearch, setModelSearch] = useState('');
    const [customModelInput, setCustomModelInput] = useState('');

    // Hooks
    const { favorites, addFavorite } = useFavoriteModels();
    const { settings } = useIntentStore();

    // Refs for dropdowns
    const modelRef = useRef<HTMLDivElement>(null);
    const sourcesRef = useRef<HTMLDivElement>(null);
    const timeRef = useRef<HTMLDivElement>(null);

    // Sync selected model with Settings model updates only if user has no explicit chat selection.
    useEffect(() => {
        if (!settings?.defaultModel) return;
        if (!selectedModel) {
            setSelectedModel(settings.defaultModel);
            const prov = resolveProviderForModel(settings.defaultModel);
            setSelectedProvider(prov);
            setStoredModelWithProvider(CHAT_MODEL_STORAGE_KEY, settings.defaultModel, prov);
        }
    }, [settings?.defaultModel, selectedModel]);

    useEffect(() => {
        try {
            if (selectedModel) {
                // Validate model ID — only allow safe characters
                const safe = /^[a-zA-Z0-9\-_/:. @]+$/.test(selectedModel) && selectedModel.length < 200;
                if (safe) {
                    setStoredModelWithProvider(CHAT_MODEL_STORAGE_KEY, selectedModel, selectedProvider);
                }
            } else {
                localStorage.removeItem(CHAT_MODEL_STORAGE_KEY);
                localStorage.removeItem(`${CHAT_MODEL_STORAGE_KEY}_provider`);
            }
        } catch {
            // ignore storage errors
        }
    }, [selectedModel, selectedProvider]);

    const { groups: cloudGroups, allModels: allCloudModels, loading: cloudLoading, error: cloudErrorRaw, refetch: refetchCloud } = useMultiProviderModels(settings);
    const cloudModels = useMemo(() => allCloudModels.map(m => ({ id: m.id, name: m.name })), [allCloudModels]);
    const cloudError = cloudErrorRaw ? String(cloudErrorRaw) : null;

    const fetchLMStudioModels = useCallback(async () => {
        setLmStudioLoading(true);
        setLmStudioError(null);
        const lmStudioUrl = 'http://127.0.0.1:1234';
        try {
            const models = await getLMStudioModels(lmStudioUrl);
            setLmStudioModels(models);
            if (models.length > 0 && !selectedModel) {
                const first = models[0].id;
                setSelectedModel(first);
                setSelectedProvider('local');
                setStoredModelWithProvider(CHAT_MODEL_STORAGE_KEY, first, 'local');
            }
        } catch {
            setLmStudioError(`LM Studio not reachable at ${lmStudioUrl}`);
            setLmStudioModels([]);
        } finally {
            setLmStudioLoading(false);
        }
    }, [selectedModel]);

    // Auto-fetch models when mode changes
    useEffect(() => {
        if (modelMode === 'local') {
            fetchLMStudioModels();
        }
    }, [modelMode, fetchLMStudioModels]);

    // Close dropdowns on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
                setShowModelDropdown(false);
            }
            if (sourcesRef.current && !sourcesRef.current.contains(e.target as Node)) {
                setShowSourcesDropdown(false);
            }
            if (timeRef.current && !timeRef.current.contains(e.target as Node)) {
                setShowTimeDropdown(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Load sessions on mount
    useEffect(() => {
        loadSessions();
    }, []);

    // Handle initial prompt (from Homepage summary cards)
    useEffect(() => {
        if (initialPrompt && !initialPromptHandled.current && !isSending) {
            initialPromptHandled.current = true;
            setInput(initialPrompt);
            setTimeout(() => {
                handleSendWithMessage(initialPrompt);
            }, 300);
        }
    }, [initialPrompt]);

    // Load messages when active session changes
    useEffect(() => {
        if (activeSessionId) {
            loadMessages(activeSessionId);
        } else {
            setMessages([]);
        }
        setStreamingContent('');
    }, [activeSessionId]);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, streamingContent]);

    useEffect(() => {
        streamingContentRef.current = streamingContent;
    }, [streamingContent]);

    // Listen for streaming tokens
    useEffect(() => {
        const controller = new AbortController();
        const signal = controller.signal;
        const unlisteners: Array<() => void> = [];
        
        let tokenBuffer = '';
        let flushTimeout: ReturnType<typeof setTimeout> | null = null;
        
        async function setupListener() {
            const unlistenToken = await listen<string>('chat://token', (event) => {
                if (signal.aborted) return;
                if (stoppedRequestIdsRef.current.has(activeRequestIdRef.current)) return;
                tokenBuffer += event.payload;
                
                if (flushTimeout) clearTimeout(flushTimeout);
                flushTimeout = setTimeout(() => {
                    if (signal.aborted) return;
                    if (stoppedRequestIdsRef.current.has(activeRequestIdRef.current)) return;
                    setStreamingContent((prev) => prev + tokenBuffer);
                    tokenBuffer = '';
                }, 30);
            });
            const unlistenStatus = await listen<string>('chat://status', (event) => {
                if (signal.aborted) return;
                if (stoppedRequestIdsRef.current.has(activeRequestIdRef.current)) return;
                setAgentStatus(event.payload || '');
            });
            const unlistenDone = await listen<string>('chat://done', () => {
                if (signal.aborted) return;
                setAgentStatus('');
                setDisplayedStatus('');
            });
            if (signal.aborted) {
                unlistenToken();
                unlistenStatus();
                unlistenDone();
            } else {
                unlisteners.push(unlistenToken, unlistenStatus, unlistenDone);
            }
        }
        setupListener();
        return () => {
            controller.abort();
            unlisteners.forEach((fn) => fn());
        };
    }, []);

    useEffect(() => {
        if (!agentStatus) {
            setDisplayedStatus('');
            return;
        }
        let i = 0;
        const timer = window.setInterval(() => {
            i = Math.min(i + 1, agentStatus.length);
            setDisplayedStatus(agentStatus.slice(0, i));
            if (i >= agentStatus.length) window.clearInterval(timer);
        }, 12);
        return () => window.clearInterval(timer);
    }, [agentStatus]);

    const loadSessions = async () => {
        try {
            const data = await getChatSessions();
            setSessions(data);
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    };

    const loadMessages = async (sessionId: string) => {
        try {
            const data = await getChatMessages(sessionId);
            setMessages(data);
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    };

    const handleNewSession = async () => {
        if (isSending) {
            const currentRequestId = activeRequestIdRef.current;
            stoppedRequestIdsRef.current.add(currentRequestId);
            if (window.atheletiaAPI?.intent?.cancelChat) {
                window.atheletiaAPI.intent.cancelChat();
            }
            setIsSending(false);
            setStreamingContent('');
            setAgentStatus('');
            setDisplayedStatus('');
        }
        try {
            const session = await createChatSession();
            setSessions((prev) => [session, ...prev]);
            setActiveSessionId(session.id);
            setMessages([]);
            setInput('');
            setStreamingContent('');
            streamingContentRef.current = '';
            inputRef.current?.focus();
        } catch (error) {
            console.error('Failed to create session:', error);
        }
    };

    const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await deleteChatSession(id);
            setSessions((prev) => prev.filter((s) => s.id !== id));
            if (activeSessionId === id) {
                setActiveSessionId(null);
                setMessages([]);
            }
        } catch (error) {
            console.error('Failed to delete session:', error);
        }
    };

    const handleSendWithMessage = async (
        messageText: string,
        overrides?: { timeRange?: string; sources?: ChatSourceId[] }
    ) => {
        if (!messageText.trim() || isSending) return;

        setShowModelDropdown(false);
        setShowSourcesDropdown(false);
        setShowTimeDropdown(false);

        let sessionId = activeSessionId;
        if (!sessionId) {
            try {
                const session = await createChatSession();
                setSessions((prev) => [session, ...prev]);
                setActiveSessionId(session.id);
                sessionId = session.id;
            } catch (error) {
                console.error('Failed to create session:', error);
                return;
            }
        }

        setInput('');
        setIsSending(true);
        setStreamingContent('');
        setAgentStatus('Preparing search...');

        const requestId = ++activeRequestIdRef.current;

        const tempUserMsg: ChatMessageType = {
            id: Date.now(),
            session_id: sessionId,
            role: 'user',
            content: messageText.trim(),
            created_at: Math.floor(Date.now() / 1000),
        };
        setMessages((prev) => [...prev, tempUserMsg]);

        try {
            const provider = modelMode === 'local'
                ? 'local'
                : resolveProviderForModel(selectedModel, selectedProvider);
            const apiKey = getProviderKey(settings, provider);

            const response = await sendChatMessage(
                sessionId,
                messageText.trim(),
                selectedModel || undefined,
                provider,
                overrides?.timeRange || selectedTimeRange,
                overrides?.sources || selectedSources,
                apiKey
            );

            // If user pressed Stop while awaiting, discard the response
            if (stoppedRequestIdsRef.current.has(requestId)) return;

            const { cleanedContent, action } = parseAssistantAction(response.content);
            const finalContent = mergeStreamThinkingIntoContent(
                cleanedContent || 'Please confirm the suggested scope/source update to continue.',
                streamingContentRef.current
            );
            const normalizedResponse: ChatMessageType = {
                ...response,
                content: finalContent,
            };
            if (selectedModel) {
                const selected = favorites.find((f) => f.id === selectedModel);
                addFavorite({ id: selectedModel, name: selected?.name || selectedModel });
            }
            setMessages((prev) => [...prev, normalizedResponse]);
            if (action?.kind === 'confirm_scope_or_sources') {
                setPendingAction(action);
            }
            loadSessions();
        } catch (error) {
            if (stoppedRequestIdsRef.current.has(requestId)) return; // Stop was pressed — don't show error
            console.error('Failed to send message:', error);
            const isAuthError = error instanceof ChatServiceError && error.code === 'AUTH';
            const isUnavailable = error instanceof ChatServiceError && error.code === 'API_UNAVAILABLE';
            const errorText = error instanceof Error ? error.message : String(error);
            const friendlyMsg = isAuthError
                ? '🔑 API key error — please check Settings → API Keys and try again.'
                : isUnavailable
                ? '⚡ App API not available. Make sure you are running inside the Atheletia desktop app.'
                : `Something went wrong: ${errorText}`;
            const errorMsg: ChatMessageType = {
                id: Date.now() + 1,
                session_id: sessionId,
                role: 'assistant',
                content: friendlyMsg,
                created_at: Math.floor(Date.now() / 1000),
            };
            setMessages((prev) => [...prev, errorMsg]);
        } finally {
            if (!stoppedRequestIdsRef.current.has(requestId)) {
                setIsSending(false);
                setStreamingContent('');
                setAgentStatus('');
                setDisplayedStatus('');
            }
        }
    };

    const handleSend = () => handleSendWithMessage(input);

    /** Stop in-progress request */
    const handleStop = useCallback(() => {
        const currentRequestId = activeRequestIdRef.current;
        stoppedRequestIdsRef.current.add(currentRequestId);
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        if (window.atheletiaAPI?.intent?.cancelChat) {
            window.atheletiaAPI.intent.cancelChat();
        }
        const capturedStreaming = streamingContentRef.current;
        if (capturedStreaming.trim()) {
            const partialMsg: ChatMessageType = {
                id: Date.now(),
                session_id: activeSessionId || '',
                role: 'assistant',
                content: capturedStreaming.trim(),
                created_at: Math.floor(Date.now() / 1000),
            };
            setMessages((prev) => [...prev, partialMsg]);
        }
        setIsSending(false);
        setStreamingContent('');
        setAgentStatus('');
        setDisplayedStatus('');
    }, [activeSessionId]);

    /** Rewind conversation to a specific user message — delete it and all after, load text into input */
    const handleRewindToMessage = useCallback(async (messageId: number) => {
        const idx = messages.findIndex(m => m.id === messageId);
        if (idx < 0) return;
        const clickedMsg = messages[idx];
        // Remove this message and all after
        const kept = messages.slice(0, idx);
        setMessages(kept);
        // Load the clicked message text into the input
        if (clickedMsg.role === 'user') {
            setInput(clickedMsg.content);
        }
        inputRef.current?.focus();
    }, [messages]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const toggleSource = (sourceId: ChatSourceId) => {
        setSelectedSources((prev) =>
            prev.includes(sourceId)
                ? prev.filter((s) => s !== sourceId)
                : [...prev, sourceId]
        );
    };

    const renderStreamingMessage = () => {
        if (!streamingContent) return null;

        // Extract the answer text that appears AFTER all tool-call JSON blocks.
        // This fixes the bug where accumulated content starts with '{' and the
        // looksLikeToolJson check stays true even after synthesis text begins.
        const answerTail = extractAnswerTail(streamingContent);

        // Check whether the TAIL of the stream still looks like in-progress JSON
        const tail200 = streamingContent.slice(-200);

        // Count open vs closed braces to detect an unclosed (in-progress) JSON block.
        // If opens > closes, the block hasn't finished streaming yet.
        const openBraces = (streamingContent.match(/\{/g) || []).length;
        const closeBraces = (streamingContent.match(/\}/g) || []).length;
        const hasUnclosedJsonBlock = streamingContent.trimStart().startsWith('{') && openBraces > closeBraces;

        const stillInToolPhase =
            (answerTail.trim().length === 0 || hasUnclosedJsonBlock) && (
                tail200.includes('"tool"') ||
                tail200.includes('"args"') ||
                tail200.includes('"reasoning"') ||
                tail200.includes('<|tool_') ||
                tail200.includes('tool_call_') ||
                // unclosed JSON block in progress (even if no keywords seen yet)
                hasUnclosedJsonBlock
            );

        const toolLabel = (name: string | null): string => {
            if (!name) return 'Analyzing your activity...';
            if (name.includes('ocr') || name.includes('screen')) return 'Searching screen activity';
            if (name.includes('recent') || name.includes('activity')) return 'Fetching recent activity';
            if (name.includes('music') || name.includes('media')) return 'Checking media history';
            if (name.includes('browser') || name.includes('web')) return 'Searching browser history';
            if (name.includes('file') || name.includes('doc')) return 'Scanning files';
            if (name.includes('usage') || name.includes('stat')) return 'Gathering usage stats';
            return `Running ${name.replace(/_/g, ' ')}`;
        };

        if (stillInToolPhase) {
            // Show the last tool name being called
            const toolNameMatch = streamingContent.match(/\"tool\"\s*:\s*\"([^\"]+)\"/g);
            const lastToolMatch = toolNameMatch?.[toolNameMatch.length - 1]?.match(/\"tool\"\s*:\s*\"([^\"]+)\"/);
            const rawTool = lastToolMatch?.[1] || null;
            return (
                <div className="flex gap-3 mb-6 justify-start">
                    <div className="flex-shrink-0 mt-1">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center"
                            style={{ background: 'linear-gradient(135deg, rgba(6,182,212,0.25) 0%, rgba(168,85,247,0.25) 100%)', border: '1px solid rgba(6,182,212,0.3)' }}>
                            <div className="w-3 h-3 rounded-full border-2 border-cyan-400/70 border-t-transparent animate-spin" />
                        </div>
                    </div>
                    <div className="rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-3"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div className="flex items-end gap-[3px]">
                            <span className="w-1 rounded-full bg-cyan-400 animate-bounce" style={{height: '8px', animationDelay: '0ms'}} />
                            <span className="w-1 rounded-full bg-cyan-400 animate-bounce" style={{height: '12px', animationDelay: '150ms'}} />
                            <span className="w-1 rounded-full bg-purple-400 animate-bounce" style={{height: '8px', animationDelay: '300ms'}} />
                        </div>
                        <span className="text-sm text-gray-300">{toolLabel(rawTool)}</span>
                    </div>
                </div>
            );
        }

        // Synthesis phase — stream the answer text
        const tempMsg: ChatMessageType = {
            id: -1,
            session_id: activeSessionId || '',
            role: 'assistant',
            content: answerTail || streamingContent,
            created_at: Date.now() / 1000,
        };
        return <ChatMessage message={tempMsg} isStreaming={true} />;
    };

    const getModelDisplayName = () => {
        if (!selectedModel) return 'Select Model';
        const fav = favorites.find((f) => f.id === selectedModel);
        if (fav) return fav.name;
        const cloud = allCloudModels.find((m) => m.id === selectedModel);
        if (cloud) return cloud.name;
        const local = lmStudioModels.find((m) => m.id === selectedModel);
        if (local) return local.name;
        const parts = selectedModel.split('/');
        return parts[parts.length - 1] || selectedModel;
    };

    const selectChatModel = (modelId: string, modelName?: string, provider?: string) => {
        const normalizedId = modelId.trim();
        if (!normalizedId) return;
        const resolvedProvider = modelMode === 'local'
            ? 'local'
            : resolveProviderForModel(normalizedId, provider);
        setSelectedModel(normalizedId);
        setSelectedProvider(resolvedProvider);
        setStoredModelWithProvider(CHAT_MODEL_STORAGE_KEY, normalizedId, resolvedProvider);
        addFavorite({ id: normalizedId, name: modelName || normalizedId });
        setShowModelDropdown(false);
        setModelSearch('');
        setCustomModelInput('');
    };

    const filteredCloudGroups = cloudGroups.map(group => ({
        ...group,
        models: group.models.filter(model => {
            const query = modelSearch.trim().toLowerCase();
            if (!query) return true;
            return model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query);
        })
    })).filter(g => g.models.length > 0);

    const getTimeRangeLabel = () =>
        TIME_RANGE_OPTIONS.find((t) => t.id === selectedTimeRange)?.label || 'Today';

    const getSourcesSummary = () => {
        if (selectedSources.length === SOURCE_OPTIONS.length) return 'All Sources';
        if (selectedSources.length === 0) return 'No Sources';
        return `${selectedSources.length} Sources`;
    };

    const getSourceLabelById = (id: ChatSourceId) =>
        SOURCE_OPTIONS.find((s) => s.id === id)?.label || id;

    const getTimeRangeLabelById = (id?: string) =>
        TIME_RANGE_OPTIONS.find((t) => t.id === id)?.label || id || '';

    const handleConfirmAction = async () => {
        if (!pendingAction) return;
        const nextTimeRange = pendingAction.suggested_time_range || selectedTimeRange;
        const enabledSources = normalizeChatSources(pendingAction.enable_sources);
        const nextSources = Array.from(
            new Set<ChatSourceId>([...(selectedSources || []), ...enabledSources])
        );
        if (pendingAction.suggested_time_range) setSelectedTimeRange(nextTimeRange);
        if (enabledSources.length > 0) setSelectedSources(nextSources);
        const retryMessage = pendingAction.retry_message || input.trim();
        setPendingAction(null);
        await handleSendWithMessage(retryMessage, { timeRange: nextTimeRange, sources: nextSources });
    };

    const formatSessionDate = (timestamp: number) => {
        const d = new Date(timestamp * 1000);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    const hasMessages = messages.length > 0;

    // Control bar (shared between empty and message states)
    const controlBar = (
        <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
                {/* Cloud / Local toggle */}
                <div className="flex items-center rounded-full bg-white/5 border border-[#333]/50 p-0.5">
                    <button
                        onClick={() => setModelMode('cloud')}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all ${modelMode === 'cloud' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                        <Cloud className="w-3 h-3" /> Cloud
                    </button>
                    <button
                        onClick={() => setModelMode('local')}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all ${modelMode === 'local' ? 'bg-emerald-600 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                        <Cpu className="w-3 h-3" /> Local
                    </button>
                </div>

                {/* Model selector */}
                <div className="relative" ref={modelRef}>
                    <button
                        onClick={() => {
                            setShowModelDropdown(!showModelDropdown);
                            setShowSourcesDropdown(false);
                            setShowTimeDropdown(false);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/5 border border-[#333]/50 text-sm text-gray-200 hover:text-white hover:border-[#444] transition-colors"
                    >
                        {modelMode === 'local' ? (
                            <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                            <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                        )}
                        <span className="text-xs font-medium max-w-[140px] truncate">{getModelDisplayName()}</span>
                        <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showModelDropdown && (
                        <div className="absolute bottom-full mb-2 left-0 w-72 bg-[#0d0d0d] backdrop-blur-2xl border border-[#333] rounded-xl shadow-2xl shadow-black/60 z-dropdown py-1 max-h-72 overflow-y-auto">
                            {modelMode === 'local' ? (
                                <>
                                    <div className="px-3 py-2 border-b border-[#333]/50 flex items-center justify-between">
                                        <div className="min-w-0">
                                            <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">LM Studio — Loaded Models</p>
                                            <p className="text-[10px] text-gray-500 truncate">{(settings as {lmstudio_url?: string})?.lmstudio_url ?? 'http://127.0.0.1:1234'}</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] ${lmStudioError ? 'text-red-400' : 'text-emerald-400'}`}>
                                                {lmStudioError ? 'Offline' : 'Online'}
                                            </span>
                                            <button onClick={fetchLMStudioModels} className="text-gray-400 hover:text-white transition-colors" title="Refresh">
                                                {lmStudioLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                            </button>
                                        </div>
                                    </div>
                                    {lmStudioError ? (
                                        <div className="px-3 py-4 text-center">
                                            <p className="text-xs text-red-400">{lmStudioError}</p>
                                            <p className="text-[10px] text-gray-500 mt-1">Make sure LM Studio is running with the server enabled</p>
                                        </div>
                                    ) : lmStudioLoading ? (
                                        <div className="px-3 py-4 flex items-center justify-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                                            <p className="text-xs text-gray-400">Detecting models...</p>
                                        </div>
                                    ) : lmStudioModels.length === 0 ? (
                                        <div className="px-3 py-4 text-center">
                                            <p className="text-xs text-gray-500">No models loaded</p>
                                            <p className="text-[10px] text-gray-600 mt-1">Load a model in LM Studio first</p>
                                        </div>
                                    ) : (
                                        lmStudioModels.map((model) => (
                                            <button
                                                key={model.id}
                                                onClick={() => selectChatModel(model.id, model.name)}
                                                className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/10 transition-colors ${selectedModel === model.id ? 'text-emerald-400' : 'text-gray-200'}`}
                                            >
                                                <Cpu className="w-3.5 h-3.5 flex-shrink-0" />
                                                <span className="flex-1 truncate text-xs">{model.name}</span>
                                                {selectedModel === model.id && <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
                                            </button>
                                        ))
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="px-3 py-2 border-b border-[#333]/50 flex items-center justify-between">
                                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                                            Cloud Models
                                        </p>
                                        <div className="flex items-center gap-2">
                                            <button onClick={refetchCloud} className="text-gray-400 hover:text-white transition-colors" title="Refresh models">
                                                {cloudLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                            </button>
                                        </div>
                                    </div>
                                    <div className="px-3 py-1.5 border-b border-[#333]/50">
                                        <div className="relative">
                                            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1.5" />
                                            <input
                                                value={modelSearch}
                                                onChange={(e) => setModelSearch(e.target.value)}
                                                placeholder="Search models"
                                                className="w-full bg-[#111] border border-[#333] rounded-md pl-7 pr-2 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 focus:outline-none focus:border-[#555]"
                                            />
                                        </div>
                                    </div>
                                    {cloudError && (
                                        <div className="px-3 py-2.5 border-b border-[#333]/50">
                                            <p className="text-[11px] text-amber-300">{cloudError}</p>
                                        </div>
                                    )}
                                    {cloudModels.length === 0 && !cloudLoading && !cloudError && (
                                        <div className="px-3 py-2 border-b border-[#333]/50">
                                            <p className="text-[10px] text-gray-500">No models found. Add an API key in Settings, or type a model ID below.</p>
                                        </div>
                                    )}
                                    {cloudLoading ? (
                                        <div className="px-3 py-4 flex items-center justify-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                                            <p className="text-xs text-gray-400">Loading models...</p>
                                        </div>
                                    ) : filteredCloudGroups.length === 0 ? (
                                        <div className="px-3 py-4 text-center">
                                            <p className="text-xs text-gray-500">No matching models</p>
                                            <p className="text-[10px] text-gray-600 mt-1">Type a model ID below to use any model</p>
                                        </div>
                                    ) : (
                                        filteredCloudGroups.map((group) => (
                                            <div key={group.provider} className="border-b border-[#333]/30 last:border-b-0">
                                                <div className="px-3 py-1.5 bg-white/5">
                                                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{group.label}</p>
                                                </div>
                                                {group.models.map((model) => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => selectChatModel(model.id, model.name, group.provider)}
                                                        className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/10 transition-colors ${selectedModel === model.id ? 'text-blue-400' : 'text-gray-200'}`}
                                                    >
                                                        <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                                                        <span className="flex-1 truncate text-xs">{model.name || model.id}</span>
                                                        {selectedModel === model.id && <Check className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />}
                                                    </button>
                                                ))}
                                            </div>
                                        ))
                                    )}
                                    <div className="px-3 py-2 border-t border-[#333]/50">
                                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Use Any Model ID</p>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                value={customModelInput}
                                                onChange={(e) => setCustomModelInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        selectChatModel(customModelInput);
                                                    }
                                                }}
                                                placeholder="e.g. kimi-k2-instruct-0905"
                                                className="flex-1 bg-[#111] border border-[#333] rounded-md px-2 py-1.5 text-[11px] text-gray-100 placeholder-gray-500 focus:outline-none focus:border-[#555]"
                                            />
                                            <button
                                                onClick={() => selectChatModel(customModelInput)}
                                                className="px-2.5 py-1.5 rounded-md bg-blue-600 text-[11px] text-white hover:bg-blue-500 transition-colors"
                                            >
                                                Use
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Sources */}
                <div className="relative" ref={sourcesRef}>
                    <button
                        onClick={() => {
                            setShowSourcesDropdown(!showSourcesDropdown);
                            setShowModelDropdown(false);
                            setShowTimeDropdown(false);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/5 border border-[#333]/50 text-sm text-gray-200 hover:text-white hover:border-[#444] transition-colors"
                    >
                        <Grid3X3 className="w-3.5 h-3.5" />
                        <span className="text-xs font-medium">{getSourcesSummary()}</span>
                        <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${showSourcesDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showSourcesDropdown && (
                        <div className="absolute bottom-full mb-2 left-0 w-56 bg-[#0d0d0d] backdrop-blur-2xl border border-[#333] rounded-xl shadow-2xl shadow-black/60 z-dropdown py-1">
                            <div className="px-3 py-2 border-b border-[#333]/50">
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Data Sources</p>
                            </div>
                            {SOURCE_OPTIONS.map((source) => (
                                <button
                                    key={source.id}
                                    onClick={() => toggleSource(source.id)}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors"
                                >
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${selectedSources.includes(source.id) ? 'bg-blue-500 border-blue-500' : 'border-[#444] bg-transparent'}`}>
                                        {selectedSources.includes(source.id) && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <span className={`text-xs ${selectedSources.includes(source.id) ? 'text-white' : 'text-gray-300'}`}>
                                        {source.label}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Time Range */}
                <div className="relative" ref={timeRef}>
                    <button
                        onClick={() => {
                            setShowTimeDropdown(!showTimeDropdown);
                            setShowModelDropdown(false);
                            setShowSourcesDropdown(false);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/5 border border-[#333]/50 text-sm text-gray-200 hover:text-white hover:border-[#444] transition-colors"
                    >
                        <Calendar className="w-3.5 h-3.5" />
                        <span className="text-xs font-medium">{getTimeRangeLabel()}</span>
                        <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${showTimeDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showTimeDropdown && (
                        <div className="absolute bottom-full mb-2 left-0 w-48 bg-[#0d0d0d] backdrop-blur-2xl border border-[#333] rounded-xl shadow-2xl shadow-black/60 z-dropdown py-1">
                            <div className="px-3 py-2 border-b border-[#333]/50">
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Time Range</p>
                            </div>
                            {TIME_RANGE_OPTIONS.map((range) => (
                                <button
                                    key={range.id}
                                    onClick={() => { setSelectedTimeRange(range.id); setShowTimeDropdown(false); }}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors ${selectedTimeRange === range.id ? 'text-blue-400' : 'text-gray-200'}`}
                                >
                                    <span className="flex-1 text-xs">{range.label}</span>
                                    {selectedTimeRange === range.id && <Check className="w-3.5 h-3.5 text-blue-400" />}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

        </div>
    );

    return (
        <div className="flex h-full" style={{ background: 'var(--bg-app)' }}>
            {/* Chat History Panel */}
            {showHistory && (
                <div className="w-64 flex-shrink-0 flex flex-col" style={{ background: 'var(--bg-elev-1)', borderRight: '1px solid var(--border-default)' }}>
                    <div className="flex items-center justify-between px-3 py-3 border-b border-[#1f2329]">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">History</span>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={handleNewSession}
                                className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                                title="New chat"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setShowHistory(false)}
                                className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                                title="Close history"
                            >
                                <PanelLeft className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto py-2">
                        {sessions.length === 0 ? (
                            <div className="px-3 py-8 text-center">
                                <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center mx-auto mb-3">
                                    <MessageSquare className="w-5 h-5 text-gray-600" />
                                </div>
                                <p className="text-xs text-gray-500">No conversations yet</p>
                                <button
                                    onClick={handleNewSession}
                                    className="mt-3 text-xs text-cyan-400/70 hover:text-cyan-400 transition-colors"
                                >
                                    Start your first chat
                                </button>
                            </div>
                        ) : (
                            sessions.map((session) => (
                                <button
                                    key={session.id}
                                    onClick={() => {
                                        if (isSending) {
                                            const currentRequestId = activeRequestIdRef.current;
                                            stoppedRequestIdsRef.current.add(currentRequestId);
                                            if (window.atheletiaAPI?.intent?.cancelChat) {
                                                window.atheletiaAPI.intent.cancelChat();
                                            }
                                            setIsSending(false);
                                            setStreamingContent('');
                                            streamingContentRef.current = '';
                                            setAgentStatus('');
                                            setDisplayedStatus('');
                                        }
                                        setActiveSessionId(session.id);
                                    }}
                                    className={`group w-full flex items-start gap-2 px-3 py-2.5 text-left transition-all ${
                                        activeSessionId === session.id
                                            ? 'bg-cyan-500/10 border-l-2 border-cyan-500/60'
                                            : 'border-l-2 border-transparent hover:bg-white/[0.04]'
                                    }`}
                                >
                                    <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-600" />
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-xs font-medium truncate ${activeSessionId === session.id ? 'text-white' : 'text-gray-300'}`}>
                                            {session.title || 'New Chat'}
                                        </p>
                                        <p className="text-[10px] text-gray-600 mt-0.5">
                                            {formatSessionDate(session.updated_at)}
                                        </p>
                                    </div>
                                    <button
                                        onClick={(e) => handleDeleteSession(session.id, e)}
                                        className="opacity-0 group-hover:opacity-100 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-red-400 transition-all"
                                        title="Delete"
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Main Chat Area */}
            <div className="flex-1 flex flex-col min-w-0">
                {!showHistory && (
                    <div className="px-4 py-2 flex-shrink-0">
                        <button
                            onClick={() => setShowHistory(true)}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                            title="Show chat history"
                        >
                            <PanelLeft className="w-[18px] h-[18px]" />
                        </button>
                    </div>
                )}

                {hasMessages ? (
                    <>
                        <div className="flex-1 overflow-y-auto px-6 py-4">
                            <div className="max-w-3xl mx-auto">
                                {messages.map((msg) => (
                                    <div key={msg.id} className="group/msg relative">
                                        <ChatMessage message={msg} />
                                        {msg.role === 'user' && !isSending && (
                                            <button
                                                onClick={() => handleRewindToMessage(msg.id)}
                                                className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-amber-400 hover:bg-white/10 transition-all border border-transparent hover:border-white/10 shadow-sm"
                                                title="Undo — rewind to this message and edit it"
                                            >
                                                <Undo2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                ))}
                                {streamingContent ? renderStreamingMessage() : isSending && (
                                    <div className="flex gap-3 mb-6 justify-start">
                                        <div className="flex-shrink-0 mt-1">
                                            <div className="w-7 h-7 rounded-full flex items-center justify-center"
                                                style={{ background: 'linear-gradient(135deg, rgba(6,182,212,0.2) 0%, rgba(168,85,247,0.2) 100%)', border: '1px solid rgba(6,182,212,0.25)' }}>
                                                <div className="w-3 h-3 rounded-full border-2 border-cyan-400/60 border-t-transparent animate-spin" />
                                            </div>
                                        </div>
                                        <div className="rounded-2xl rounded-bl-sm px-4 py-3"
                                            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm text-gray-300">
                                                    {displayedStatus || agentStatus || 'Thinking'}
                                                </span>
                                                <span className="inline-flex gap-0.5">
                                                    <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" style={{animationDelay:'0ms'}} />
                                                    <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" style={{animationDelay:'120ms'}} />
                                                    <span className="w-1 h-1 rounded-full bg-gray-400 animate-bounce" style={{animationDelay:'240ms'}} />
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {isSending && agentStatus && streamingContent && (
                                    <div className="flex justify-start mb-2 pl-10">
                                        <div className="rounded-xl px-2.5 py-1"
                                            style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.15)' }}>
                                            <span className="text-[11px] text-cyan-400/70">{displayedStatus || agentStatus}</span>
                                        </div>
                                    </div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>
                        </div>

                        <div className="border-t px-6 py-4" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elev-1)' }}>
                            <div className="max-w-3xl mx-auto space-y-3">
                                <div className="relative">
                                    <textarea
                                        ref={inputRef}
                                        value={input}
                                        onChange={(e) => setInput(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        onFocus={() => {
                                            setShowModelDropdown(false);
                                            setShowSourcesDropdown(false);
                                            setShowTimeDropdown(false);
                                        }}
                                        placeholder="Ask about your activity..."
                                        rows={1}
                                        className="w-full resize-none bg-[#161616] border border-[#333]/70 text-white rounded-xl px-4 py-3 pr-12 text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 focus:border-cyan-500/40 scrollbar-none"
                                        style={{ minHeight: '44px', maxHeight: '120px' }}
                                        onInput={(e) => {
                                            const t = e.target as HTMLTextAreaElement;
                                            t.style.height = 'auto';
                                            t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
                                        }}
                                    />
                                    {isSending ? (
                                        <button
                                            onClick={handleStop}
                                            className="absolute right-2 bottom-2 w-9 h-9 flex items-center justify-center rounded-lg bg-red-500/20 text-red-400 hover:text-red-300 hover:bg-red-500/30 border border-red-500/30 transition-colors shadow-sm"
                                            title="Stop generating"
                                        >
                                            <Square className="w-4 h-4 fill-current" />
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleSend}
                                            disabled={!input.trim()}
                                            className="absolute right-2 bottom-2 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-cyan-400 disabled:opacity-30 disabled:hover:text-gray-400 transition-colors"
                                        >
                                            <Send className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                                {controlBar}
                            </div>
                        </div>
                    </>
                ) : (
                    /* Empty state */
                    <div className="flex-1 flex flex-col overflow-hidden">
                        {/* Centered greeting + cards */}
                        <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 overflow-y-auto">                        <div className="w-full max-w-2xl space-y-6">
                            <div className="text-center">
                                {/* Glow orb */}
                                <div className="relative inline-flex items-center justify-center w-16 h-16 mb-4">
                                    <div className="absolute inset-0 rounded-full blur-xl opacity-40" style={{ background: 'radial-gradient(circle, #06b6d4 0%, #8b5cf6 100%)' }} />
                                    <div className="relative w-14 h-14 rounded-2xl flex items-center justify-center"
                                        style={{ background: 'linear-gradient(135deg, rgba(6,182,212,0.2) 0%, rgba(139,92,246,0.2) 100%)', border: '1px solid rgba(6,182,212,0.3)' }}>
                                        <BriefcaseBusiness className="w-7 h-7 text-cyan-400" />
                                    </div>
                                </div>
                                <h2 className="text-3xl font-bold text-white tracking-tight">What would you like to know?</h2>
                                <p className="text-sm text-gray-500 mt-2">Ask about your activity, get summaries, or explore patterns from your history</p>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {SUGGESTION_CARDS.map((card, idx) => (
                                    <button
                                        key={card.label}
                                        onClick={() => {
                                            setInput(card.prompt);
                                            setTimeout(() => handleSendWithMessage(card.prompt), 50);
                                        }}
                                        className="group flex items-start gap-3 p-4 rounded-2xl text-left transition-all duration-200 hover:-translate-y-0.5"
                                        style={{
                                            background: 'rgba(255,255,255,0.03)',
                                            border: '1px solid rgba(255,255,255,0.07)',
                                            animationDelay: `${idx * 60}ms`,
                                        }}
                                        onMouseEnter={e => {
                                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
                                            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)';
                                        }}
                                        onMouseLeave={e => {
                                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)';
                                            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.07)';
                                        }}
                                    >
                                        <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
                                            style={{ background: 'rgba(255,255,255,0.06)' }}>
                                            <card.icon className={`w-4 h-4 ${card.color}`} />
                                        </div>
                                        <div>
                                            <p className="text-xs font-semibold text-white mb-0.5">{card.label}</p>
                                            <p className="text-[11px] text-gray-500 leading-relaxed">{card.prompt}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div></div>
                        {/* Pinned input bar — same structure as messages view so dropdowns open upward */}
                        <div className="border-t px-6 py-4 flex-shrink-0" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elev-1)' }}>
                            <div className="max-w-2xl mx-auto space-y-3">
                                <div className="relative">
                                    <textarea
                                        ref={inputRef}
                                        value={input}
                                        onChange={(e) => setInput(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        onFocus={() => {
                                            setShowModelDropdown(false);
                                            setShowSourcesDropdown(false);
                                            setShowTimeDropdown(false);
                                        }}
                                        placeholder="Ask about moments or topics from your memories..."
                                        rows={1}
                                        className="w-full resize-none bg-[#161616] border border-[#333]/70 text-white rounded-xl px-4 py-3 pr-12 text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 focus:border-cyan-500/40"
                                        style={{ minHeight: '44px', maxHeight: '120px' }}
                                        onInput={(e) => {
                                            const t = e.target as HTMLTextAreaElement;
                                            t.style.height = 'auto';
                                            t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
                                        }}
                                    />
                                    {isSending ? (
                                        <button
                                            onClick={handleStop}
                                            className="absolute right-2 bottom-2 w-9 h-9 flex items-center justify-center rounded-lg bg-red-500/20 text-red-400 hover:text-red-300 hover:bg-red-500/30 border border-red-500/30 transition-colors shadow-sm"
                                            title="Stop generating"
                                        >
                                            <Square className="w-4 h-4 fill-current" />
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleSend}
                                            disabled={!input.trim()}
                                            className="absolute right-2 bottom-2 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-cyan-400 disabled:opacity-30 disabled:hover:text-gray-400 transition-colors"
                                        >
                                            <Send className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                                {controlBar}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {pendingAction && (
                <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/55 px-4">
                    <div className="w-full max-w-md rounded-2xl border border-[#333] bg-[#161616] p-5 shadow-2xl">
                        <h3 className="text-sm font-semibold text-white">Allow Scope Update?</h3>
                        <p className="mt-2 text-xs text-gray-300 leading-relaxed">{pendingAction.reason}</p>
                        {pendingAction.suggested_time_range && (
                            <p className="mt-2 text-xs text-gray-200">
                                Time range change:
                                <span className="text-blue-400"> {getTimeRangeLabelById(selectedTimeRange)}</span>
                                {' -> '}
                                <span className="text-blue-400">{getTimeRangeLabelById(pendingAction.suggested_time_range)}</span>
                            </p>
                        )}
                        {(pendingAction.enable_sources || []).length > 0 && (
                            <p className="mt-2 text-xs text-gray-200">
                                Enable sources:
                                <span className="text-blue-400">
                                    {' '}
                                    {(pendingAction.enable_sources || []).map(getSourceLabelById).join(', ')}
                                </span>
                            </p>
                        )}
                        <div className="mt-4 flex items-center justify-end gap-2">
                            <button
                                onClick={() => setPendingAction(null)}
                                className="px-3 py-1.5 rounded-lg border border-[#333] text-xs text-gray-300 hover:text-white hover:border-[#444] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmAction}
                                className="px-3 py-1.5 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 transition-colors"
                            >
                                Yes, Continue
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
