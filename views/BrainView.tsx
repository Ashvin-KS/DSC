import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';

import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  MoreHorizontal,
  Sparkles,
  File,
  Send,
  FolderOpen,
  RefreshCw,
  FilePlus,
  Save,
  Edit3,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Bold,
  Italic,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Quote,
  Square,
  Trash2,
  Undo2,
  Cloud,
  Cpu,
  Loader2,
  Check,
  Minus,
  Plus
} from 'lucide-react';
import { BrainActionType, BrainChatMessage, BrainChatOption, ParsedActionPayload, buildBrainNoteContext, buildModelConversation, inferActionContentFromResponse, isUiTranscriptNoise, parseActionPayload, sanitizeProposedMarkdown } from '../services/brainAiService';
import { StatusBanner } from '../components/ui/StatusBanner';
import { useIntentStore } from '../store/useIntentStore';
import { useMultiProviderModels, getStoredModelWithProvider, setStoredModelWithProvider, inferProviderFromModel } from '../hooks/useMultiProviderModels';
import { getProviderKey, resolveProviderForModel } from '../lib/modelFetch';
import { MermaidBlock } from '../components/MermaidBlock';
import { buildFileTreeSignature, cacheFileContent, cacheFileTree, getCachedFileContent, getCachedFileTree, invalidateFileTreeCache } from '../lib/notesCache';
import { ChatInputBox, FileTreeItemReal, MarkdownRenderer, ChatBubble } from './brain/BrainViewSupportComponents';
import { McqPopup } from '../components/McqPopup';
import { parseMcqSetFromText, useMcqStore } from '../store/useMcqStore';
import {
  createTryHandleVaultMultiFileChainIntent,
  createTryHandleVaultFileListIntent,
  createHandleAiSend,
  createHandleApplyAction,
  createResolveVaultFilePathWithConfidence,
  createResolveVaultNodePathWithConfidence,
  createResolveVaultDestinationWithConfidence,
  createPushVaultClarificationQuestion,
  createHandleVaultMessageOptionSelect,
  createHandleFileDrop,
  createBuildBrainVaultContext,
  createSubmitClarificationAnswer,
  createHandleChatOptionSelect,
  createHandleChatFreeTextReply,
  createHandleRevertAction,
} from './brain/BrainViewHandlers';

import { DEFAULT_VAULT, BRAIN_LAST_MODEL_STORAGE_KEY, DEFAULT_NIM_MODEL, DEFAULT_BRAIN_SCOPE, type BrainScope, type FileNode, type VaultSearchResult, type VaultIndexProgress, type VaultPathResolution, type VaultResolveConfidence, type VaultMultiFileChainState, type MultiFileInstruction, dedupeEquivalentPaths, extractMarkdownHeadingTitles, normalizeMarkdownFileName, findNodeByPath, getParentDirectory, getDirectoryForNodePath, normalizePathForComparison, areEquivalentPaths, pathIsWithin, stripWindowsExtendedPathPrefix, isAbsoluteFilePath, joinFileSystemPath, escapeRegExp, collectDirectoryPaths, collectMarkdownPaths, getErrorMessage, sanitizeVisibleBrainResponse, isMarkdownPath, filterMarkdownTree, normalizeClarificationOptions, isExplicitWholeRewriteIntent, hasOperationIntent, hasSpecificEditTarget, isAmbiguousOperationRequest, looksLikeClarificationQuestion, isVaultPathActionIntent, isBulkVaultOpenIntent, isVaultInventoryIntent, isMultiFileVaultIntent, isMultiFileChainDoneSignal, extractVaultDestinationHint, requestsCreateAndWriteInVault, extractRequestedNoteTitle, parseMultiFileInstruction, buildMultiFileStarterMarkdown, buildBrainActionPreview, MARKDOWN_STYLES, flattenReactNodeText, normalizeMermaidChart, firstMermaidDirectiveLine, looksLikeMermaid, extractMermaidChart, extractPreCodePayload, TiptapEditor } from './brain/BrainViewShared';

const getVaultStatusTone = (message: string): 'info' | 'success' | 'warning' | 'error' | 'loading' => {
  const normalized = message.toLowerCase();
  if (!normalized) return 'info';
  if (normalized.includes('failed') || normalized.includes('error')) return 'error';
  if (normalized.includes('stopped') || normalized.includes('cancelled') || normalized.includes('canceled')) return 'warning';
  if (normalized.includes('indexing') || normalized.includes('reindex') || normalized.includes('syncing')) return 'loading';
  if (normalized.includes('indexed') || normalized.includes('synced') || normalized.includes('created') || normalized.includes('opened') || normalized.includes('reverted') || normalized.includes('saved')) return 'success';
  return 'info';
};

const McqResponseTools: React.FC<{
  text: string;
  notePath: string;
  onSave: (set: NonNullable<ReturnType<typeof parseMcqSetFromText>>) => void;
  onOpen: (set: NonNullable<ReturnType<typeof parseMcqSetFromText>>) => void;
  onDelete: (setId: string) => void;
  savedSets: { id: string; title: string; notePath?: string; topic?: string; questions: { question: string; options: string[]; answer: string; explanation?: string }[] }[];
}> = ({ text, notePath, onSave, onOpen, onDelete, savedSets }) => {
  const parsed = useMemo(() => parseMcqSetFromText(text, notePath), [text, notePath]);
  if (!parsed) return null;

  const savedMatch = savedSets.find((s) => s.title === parsed.title);

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={() => onOpen(parsed)}
        className="rounded-md border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-[11px] font-semibold text-purple-200 hover:bg-purple-500/20 transition-colors"
      >
        Take MCQ Quiz ({parsed.questions.length} questions)
      </button>
      {!savedMatch && (
        <button
          onClick={() => onSave(parsed)}
          className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-gray-400 hover:bg-white/[0.08] transition-colors"
        >
          Save
        </button>
      )}
      {savedMatch && (
        <button
          onClick={() => onDelete(savedMatch.id)}
          className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300 hover:bg-red-500/20 transition-colors"
        >
          Delete
        </button>
      )}
    </div>
  );
};

export const BrainView: React.FC = () => {
  const [vaultPath, setVaultPath] = useState<string>(() => {
    return localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT;
  });
  const [brainScope, setBrainScope] = useState<BrainScope>(() => {
    const stored = localStorage.getItem('brain_scope');
    return stored === 'vault' ? 'vault' : DEFAULT_BRAIN_SCOPE;
  });
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(() => {
    return localStorage.getItem('brain_selectedFile');
  });
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(() => {
    return localStorage.getItem('brain_selectedTreePath') || localStorage.getItem('brain_selectedFile');
  });
  const [createTargetPath, setCreateTargetPath] = useState<string | null>(() => {
    return localStorage.getItem('brain_createTargetPath');
  });
  const [fileContent, setFileContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  // Notes-specific font size (persisted to localStorage)
  const [notesFontSize, setNotesFontSize] = useState(() => {
    const stored = localStorage.getItem('brain_notesFontSize');
    return stored ? Number(stored) : 16;
  });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const [aiMessages, setAiMessages] = useState<BrainChatMessage[]>(() => {
    const initialFile = localStorage.getItem('brain_selectedFile');
    const chatKey = `brain_chat_${initialFile || 'global'}`;
    const savedChat = localStorage.getItem(chatKey);
    if (savedChat) {
      try {
        return JSON.parse(savedChat);
      } catch (e) { }
    }
    return [{ sender: 'ai', text: 'Welcome to Brain! Select a note from your vault or create a new one. I can help analyze and discuss your notes once you load them.' }];
  });
  const chatFileRef = useRef(localStorage.getItem('brain_selectedFile') || 'global');
  const [vaultMessages, setVaultMessages] = useState<BrainChatMessage[]>(() => {
    const initialVault = localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT;
    const chatKey = `brain_vault_chat_${initialVault}`;
    const savedChat = localStorage.getItem(chatKey);
    if (savedChat) {
      try {
        return JSON.parse(savedChat);
      } catch (e) { }
    }
    return [{ sender: 'ai', text: 'Vault mode can search the whole markdown vault and prepare note or folder actions from the index root.' }];
  });
  const [vaultMultiFileChain, setVaultMultiFileChain] = useState<VaultMultiFileChainState | null>(null);
  const vaultChatRef = useRef(`brain_vault_chat_${localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT}`);
  const [vaultSearchMeta, setVaultSearchMeta] = useState<VaultSearchResult | null>(null);
  const [isVaultSearchLoading, setIsVaultSearchLoading] = useState(false);
  const [isVaultReindexing, setIsVaultReindexing] = useState(false);
  const [activeVaultIndexRoot, setActiveVaultIndexRoot] = useState<string | null>(() => {
    return localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT;
  });
  const [vaultIndexProgress, setVaultIndexProgress] = useState<VaultIndexProgress | null>(null);
  const [vaultStatusMessage, setVaultStatusMessage] = useState('');
  const storedBrainModel = getStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY);
  const [selectedModel, setSelectedModel] = useState(() => storedBrainModel?.model || localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || DEFAULT_NIM_MODEL);
  const [selectedProvider, setSelectedProvider] = useState(() => storedBrainModel?.provider || '');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [aiProvider, setAiProvider] = useState<'nvidia' | 'local' | 'lmstudio'>('nvidia');
  const { settings } = useIntentStore();
  const [modelsLoading, setModelsLoading] = useState(true);

  const { groups: cloudGroups, allModels: allCloudModels, loading: cloudLoading, error: cloudErrorRaw } = useMultiProviderModels(settings);
  const cloudModels = useMemo(() => allCloudModels.map(m => ({ id: m.id, name: m.name })), [allCloudModels]);
  const cloudError = cloudErrorRaw ? String(cloudErrorRaw) : null;

  // Cloud/Local model lists
  const [lmStudioModels, setLmStudioModels] = useState<{ id: string, name?: string }[]>([]);
  const [lmStudioLoading, setLmStudioLoading] = useState(false);
  const [lmStudioError, setLmStudioError] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [pendingRewindInput, setPendingRewindInput] = useState<string | null>(null);
  const [streamingMsgIndex, setStreamingMsgIndex] = useState<number | null>(null);
  const [aiMode, setAiMode] = useState<'lecture' | 'edit' | 'mcq'>('lecture');
  const [proposedAction, setProposedAction] = useState<{
    scope: BrainScope;
    type: 'insert' | 'create' | 'edit_note' | 'create_folder' | 'move_note' | 'open_note' | 'rename_note' | 'delete_item' | 'replace_selection' | 'insert_at_cursor' | 'find_and_replace' | 'replace_all';
    content?: string;
    target_text?: string;
    originalSelection?: string;
    title?: string;
    message?: string;
    sourceFile?: string | null;
    sourcePath?: string;
    destinationPath?: string;
    targetPath?: string;
    range?: { startLine: number, endLine: number } | { from: number, to: number };
  } | null>(null);

  // Undo state
  const [previousContent, setPreviousContent] = useState<string | null>(null);

  const [selectedContext, setSelectedContext] = useState('');
  const [selectionRange, setSelectionRange] = useState<{ startLine: number, endLine: number } | null>(null);
  const [tiptapRange, setTiptapRange] = useState<{ from: number, to: number } | null>(null);
  const editorRef = useRef<any>(null); // Ref to hold Tiptap editor instance
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeVaultIndexRootRef = useRef<string | null>(localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT);
  const pendingSubtreeSyncRef = useRef<Set<string>>(new Set());
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const allMcqSets = useMcqStore((s) => s.sets);
  const mcqSets = useMemo(() => {
    if (!selectedFile) return [];
    return allMcqSets.filter((set) => set.notePath === selectedFile);
  }, [allMcqSets, selectedFile]);
  const saveMcqSet = useMcqStore((s) => s.saveSet);
  const deleteMcqSet = useMcqStore((s) => s.deleteSet);
  const [activeMcqSet, setActiveMcqSet] = useState<NonNullable<ReturnType<typeof parseMcqSetFromText>> | null>(null);

  // Load chat history when file changes
  useEffect(() => {
    const chatKey = `brain_chat_${selectedFile || 'global'}`;
    const savedChat = localStorage.getItem(chatKey);
    if (savedChat) {
      try {
        setAiMessages(JSON.parse(savedChat));
      } catch (e) {
        setAiMessages([{ sender: 'ai', text: 'Welcome to Brain! Select a note from your vault or create a new one.' }]);
      }
    } else {
      setAiMessages([{ sender: 'ai', text: 'Welcome to Brain! Select a note from your vault or create a new one.' }]);
    }
    chatFileRef.current = selectedFile || 'global';
  }, [selectedFile]);

  useEffect(() => {
    const chatKey = `brain_vault_chat_${vaultPath || DEFAULT_VAULT}`;
    const savedChat = localStorage.getItem(chatKey);
    if (savedChat) {
      try {
        setVaultMessages(JSON.parse(savedChat));
      } catch (e) {
        setVaultMessages([{ sender: 'ai', text: 'Vault mode can search the whole markdown vault and prepare note or folder actions from the index root.' }]);
      }
    } else {
      setVaultMessages([{ sender: 'ai', text: 'Vault mode can search the whole markdown vault and prepare note or folder actions from the index root.' }]);
    }
    vaultChatRef.current = chatKey;
  }, [vaultPath]);

  // Save chat history whenever it updates
  useEffect(() => {
    const chatKey = `brain_chat_${chatFileRef.current}`;
    localStorage.setItem(chatKey, JSON.stringify(aiMessages));
  }, [aiMessages]);

  useEffect(() => {
    localStorage.setItem(vaultChatRef.current, JSON.stringify(vaultMessages));
  }, [vaultMessages]);

  useEffect(() => {
    localStorage.setItem('brain_scope', brainScope);
  }, [brainScope]);

  useEffect(() => {
    activeVaultIndexRootRef.current = activeVaultIndexRoot;
  }, [activeVaultIndexRoot]);

  useEffect(() => {
    setActiveVaultIndexRoot(vaultPath);
    setVaultIndexProgress(null);
    setVaultSearchMeta(null);
    setVaultMultiFileChain(null);
  }, [vaultPath]);

  useEffect(() => {
    if (brainScope !== 'vault') {
      setVaultMultiFileChain(null);
    }
  }, [brainScope]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<VaultIndexProgress>('notes://vault-index-progress', (event) => {
      const payload = event.payload;
      if (!payload) return;

      const matchesOpenedVault = areEquivalentPaths(payload.vault_path, vaultPath);
      const matchesActiveVault = areEquivalentPaths(payload.vault_path, activeVaultIndexRootRef.current);
      if (!matchesOpenedVault && !matchesActiveVault) {
        if (payload.stage !== 'started') {
          return;
        }
      }

      setActiveVaultIndexRoot(payload.vault_path);
      setVaultIndexProgress(payload);
      if (payload.stage === 'started') {
        setIsVaultReindexing(true);
        setVaultStatusMessage(`Indexing ${payload.total_files} markdown note${payload.total_files === 1 ? '' : 's'}...`);
      } else if (payload.stage === 'indexing') {
        const current = payload.current_file ? ` ${payload.current_file}` : '';
        setVaultStatusMessage(`Indexed ${payload.processed_files}/${payload.total_files} notes.${current}`);
      } else if (payload.stage === 'cancelled') {
        setIsVaultReindexing(false);
        setVaultStatusMessage(`Stopped vault indexing at ${payload.processed_files}/${payload.total_files} notes.`);
      } else if (payload.stage === 'completed') {
        setIsVaultReindexing(false);
        setVaultStatusMessage(`Indexed ${payload.processed_files} markdown notes into ${payload.indexed_chunks} chunks.`);
      }
    }).then((dispose) => {
      unlisten = dispose;
    }).catch((error) => {
      console.error('Failed to listen for vault index progress:', error);
    });

    return () => {
      unlisten?.();
    };
  }, [vaultPath]);

  useEffect(() => {
    if (selectedTreePath) {
      localStorage.setItem('brain_selectedTreePath', selectedTreePath);
    }
  }, [selectedTreePath]);

  useEffect(() => {
    if (createTargetPath) {
      localStorage.setItem('brain_createTargetPath', createTargetPath);
    } else {
      localStorage.removeItem('brain_createTargetPath');
    }
  }, [createTargetPath]);

  useEffect(() => {
    if (!showModelDropdown) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!modelPopupRef.current) return;
      if (modelPopupRef.current.contains(event.target as Node)) return;
      setShowModelDropdown(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowModelDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showModelDropdown]);

  // Prevent applying stale proposals after switching to another note
  useEffect(() => {
    if (!proposedAction) return;
    if (!proposedAction.sourceFile) return;
    if (selectedFile !== proposedAction.sourceFile) {
      setProposedAction(null);
      setAiMessages(prev => [...prev, {
        sender: 'ai',
        text: 'Warning: Discarded pending proposal because the active note changed. Generate a new proposal for this note.'
      }]);
    }
  }, [selectedFile, proposedAction]);

  // Ref for the markdown view container
  const markdownContainerRef = useRef<HTMLDivElement>(null);

  // Handle Selection in View Mode using mouseup for reliability
  const handleMouseUp = () => {
    if (isEditing) return;

    // Small delay to ensure selection is finalized
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (text.length > 0) {
        setSelectedContext(text);

        // Calculate Line Numbers using smarter line-based search
        // This handles markdown formatting (##, **, -, etc.) that isn't in rendered text
        const lines = fileContent.split('\n');
        const selectedLines = text.split('\n');
        const firstSelectedLine = selectedLines[0].trim();

        let startLine = -1;
        let endLine = -1;

        // Find the first line that contains the start of the selection
        for (let i = 0; i < lines.length; i++) {
          // Check if this line contains the first line of selection (ignoring markdown chars)
          const lineWithoutMarkdown = lines[i].replace(/^[#*\->\s]+/, '').trim();
          if (lineWithoutMarkdown.includes(firstSelectedLine) || lines[i].includes(firstSelectedLine)) {
            startLine = i + 1; // 1-indexed
            break;
          }
        }

        if (startLine !== -1) {
          // Estimate end line based on selection length
          endLine = startLine + selectedLines.length - 1;
          setSelectionRange({ startLine, endLine });
        } else {
          console.warn('[Atheletia Brain] Could not find selected text in raw content');
          setSelectionRange(null);
        }
      }
    }, 10);
  };


  // Sidebar Resizing - uses refs + direct DOM manipulation for zero-lag dragging
  const [aiPanelWidth, setAiPanelWidth] = useState(380);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const aiPanelWidthRef = useRef(380);
  const isResizingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Cancel any pending rAF to avoid stacking
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const newWidth = document.body.clientWidth - e.clientX;
        if (newWidth > 280 && newWidth < 800) {
          aiPanelWidthRef.current = newWidth;
          // Direct DOM update - no React re-render
          if (sidebarRef.current) {
            sidebarRef.current.style.width = `${newWidth}px`;
          }
        }
      });
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      setIsResizing(false);
      // Commit final width to React state (single re-render)
      setAiPanelWidth(aiPanelWidthRef.current);
      // Restore text selection and cursor
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Fetch LM Studio models
  const fetchLMStudioModels = useCallback(async () => {
    setLmStudioLoading(true);
    setLmStudioError(null);
    try {
      const modelsRaw = await window.atheletiaAPI?.settings?.getLMStudioModels?.();
      const normalized = (Array.isArray(modelsRaw) ? modelsRaw : [])
        .map((m: any) => ({ id: m?.id || String(m), name: m?.name || m?.id || String(m) }))
        .filter((m: { id: string }) => !!m.id);
      setLmStudioModels(normalized);
      if (normalized.length > 0 && !selectedModel) {
        const lastModel = localStorage.getItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_local`) || localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || '';
        const hasLast = normalized.some((m: any) => m.id === lastModel);
        if (hasLast) {
          setSelectedModel(lastModel);
          setSelectedProvider('local');
          setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, lastModel, 'local');
        } else {
          setSelectedModel(normalized[0].id);
          setSelectedProvider('local');
          setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, normalized[0].id, 'local');
        }
      }
    } catch (err) {
      console.error('Failed to fetch LM Studio models:', err);
      setLmStudioError('LM Studio not reachable. Make sure it is running.');
      setLmStudioModels([]);
    } finally {
      setLmStudioLoading(false);
      setModelsLoading(false);
    }
  }, [selectedModel]);

  useEffect(() => {
    setModelsLoading(false);
  }, []);

  // Switch provider at runtime
  const switchProvider = useCallback((mode: 'nvidia' | 'lmstudio') => {
    setAiProvider(mode);
    setModelsLoading(true);
    if (mode === 'lmstudio') {
      fetchLMStudioModels();
    } else {
      setModelsLoading(false);
    }
  }, [fetchLMStudioModels]);

  useEffect(() => {
    if (!selectedModel?.trim()) return;
    setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, selectedModel, selectedProvider);
    localStorage.setItem(BRAIN_LAST_MODEL_STORAGE_KEY, selectedModel); // Legacy fallback
  }, [selectedModel, selectedProvider]);

  const selectedTreeNode = findNodeByPath(fileTree, selectedTreePath);
  const selectedDirectoryPath = getDirectoryForNodePath(createTargetPath || selectedTreePath, fileTree, vaultPath);
  const currentMessages = brainScope === 'vault' ? vaultMessages : aiMessages;
  const setCurrentMessages = brainScope === 'vault' ? setVaultMessages : setAiMessages;
  const vaultIndexPercent = vaultIndexProgress && vaultIndexProgress.total_files > 0
    ? Math.min(100, Math.round((vaultIndexProgress.processed_files / vaultIndexProgress.total_files) * 100))
    : 0;
  const activeIndexRoot = activeVaultIndexRoot || vaultPath;
  const activeIndexRootName = activeIndexRoot.split(/[/\\]/).filter(Boolean).pop() || activeIndexRoot;
  const vaultActionRoot = activeIndexRoot || vaultPath;
  const selectedModelDisplayName = selectedModel
    ? (selectedModel.split('/').filter(Boolean).pop() || selectedModel)
    : 'Select model';
  const allModels = useMemo(() => {
    if (aiProvider === 'lmstudio' || aiProvider === 'local') return lmStudioModels;
    return cloudModels;
  }, [aiProvider, lmStudioModels, cloudModels]);
  const effectiveSelectedProvider = useMemo(
    () => (aiProvider === 'lmstudio' || aiProvider === 'local')
      ? 'local'
      : resolveProviderForModel(selectedModel, selectedProvider),
    [aiProvider, selectedModel, selectedProvider]
  );
  const effectiveApiKey = useMemo(
    () => getProviderKey(settings, effectiveSelectedProvider),
    [settings, effectiveSelectedProvider]
  );
  const showVaultIndexDoneMark = brainScope === 'vault' && !isVaultReindexing && vaultIndexProgress?.stage === 'completed';
  const showVaultProgressInHeader = isVaultReindexing || vaultIndexProgress?.stage === 'indexing' || vaultIndexProgress?.stage === 'started';

  const stopVaultReindex = useCallback(async (statusMessage = 'Stopped vault indexing.') => {
    if (!window.atheletiaAPI?.notes?.cancelVaultReindex) {
      return;
    }

    try {
      await window.atheletiaAPI.notes.cancelVaultReindex();
      setIsVaultReindexing(false);
      setVaultIndexProgress((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          stage: 'cancelled',
          current_file: null,
        };
      });
      setVaultStatusMessage(statusMessage);
    } catch (error) {
      console.error('Failed to stop vault reindex:', error);
      setVaultStatusMessage(`Failed to stop vault indexing. ${getErrorMessage(error)}`);
    }
  }, []);

  const reindexOpenedVault = useCallback(async (startMessage?: string) => {
    if (!window.atheletiaAPI?.notes) return null;

    // Always index from the currently opened vault root, never from a nested folder.
    const openedVaultRoot = vaultPath;
    setActiveVaultIndexRoot(openedVaultRoot);
    setIsVaultReindexing(true);
    if (startMessage) {
      setVaultStatusMessage(startMessage);
    }

    try {
      const result = await window.atheletiaAPI.notes.reindexVault(openedVaultRoot);
      if (result?.vault_path) {
        setActiveVaultIndexRoot(result.vault_path);
      }

      if (result?.cancelled) {
        setVaultStatusMessage(`Stopped vault indexing at ${result.indexed_files} indexed notes.`);
        setVaultIndexProgress((prev) => prev ? {
          ...prev,
          stage: 'cancelled',
          current_file: null,
        } : {
          vault_path: result.vault_path,
          stage: 'cancelled',
          total_files: result.indexed_files,
          processed_files: result.indexed_files,
          indexed_chunks: result.indexed_chunks,
          current_file: null,
        });
        return result;
      }

      setVaultIndexProgress((prev) => {
        if (prev && areEquivalentPaths(prev.vault_path, result.vault_path) && prev.stage === 'completed') {
          return prev;
        }
        return {
          vault_path: result.vault_path,
          stage: 'completed',
          total_files: result.indexed_files,
          processed_files: result.indexed_files,
          indexed_chunks: result.indexed_chunks,
          current_file: null,
        };
      });

      setVaultStatusMessage(`Indexed ${result.indexed_files} markdown notes into ${result.indexed_chunks} chunks.`);
      return result;
    } catch (error: unknown) {
      setVaultStatusMessage(`Vault index failed. ${getErrorMessage(error)}`);
      throw error;
    } finally {
      setIsVaultReindexing(false);
    }
  }, [vaultPath]);

  const handleManualVaultReindex = useCallback(async () => {
    if (isVaultReindexing) {
      await stopVaultReindex('Stopped vault indexing manually.');
      return;
    }

    try {
      const result = await reindexOpenedVault('Rebuilding the markdown vault index...');
      setVaultSearchMeta(prev => prev ? {
        ...prev,
        indexedFiles: result?.indexed_files || prev.indexedFiles,
        indexedChunks: result?.indexed_chunks || prev.indexedChunks,
      } : (result ? {
        indexedFiles: result.indexed_files,
        indexedChunks: result.indexed_chunks,
        route: 'manual',
        promptContext: '',
        hits: [],
      } : null));
    } catch (error) {
      console.error('Manual vault reindex failed:', error);
      setVaultStatusMessage((prev) => prev || `Manual vault reindex failed. ${getErrorMessage(error)}`);
    }
  }, [isVaultReindexing, reindexOpenedVault, stopVaultReindex]);

  const loadFileTree = useCallback(async (force = false) => {
    if (!vaultPath || !window.atheletiaAPI?.notes) return;
    // Use cached tree if available and recent (<30s old)
    const cached = !force ? getCachedFileTree(vaultPath) : null;
    if (cached) {
      const filteredCachedTree = filterMarkdownTree(cached.tree);
      // Only update state if cached tree differs from current (avoids re-render)
      setFileTree(prev => {
        const prevSignature = buildFileTreeSignature(prev);
        const nextSignature = buildFileTreeSignature(filteredCachedTree);
        if (prevSignature === nextSignature) return prev;
        return filteredCachedTree;
      });
      return;
    }
    // Fetch fresh tree in the background - do NOT blank the old tree
    const tree = filterMarkdownTree(await window.atheletiaAPI.notes.getFileTree(vaultPath));
    const entry = cacheFileTree(vaultPath, tree);
    // Only update React state if the tree actually changed
    setFileTree(prev => {
      const prevSignature = buildFileTreeSignature(prev);
      if (prevSignature === entry.signature) return prev;
      return tree;
    });
  }, [vaultPath]);

  const syncVaultSubtreeInBackground = useCallback((subtreePath?: string | null, refreshTree = false) => {
    if (!subtreePath || !window.atheletiaAPI?.notes?.reindexSubtree) {
      return;
    }

    const cleanedPath = stripWindowsExtendedPathPrefix(subtreePath).trim();
    if (!cleanedPath) {
      return;
    }

    const syncKey = normalizePathForComparison(cleanedPath);
    if (!syncKey || pendingSubtreeSyncRef.current.has(syncKey)) {
      return;
    }

    pendingSubtreeSyncRef.current.add(syncKey);

    void window.atheletiaAPI.notes
      .reindexSubtree(cleanedPath, vaultActionRoot)
      .then((stats) => {
        if (brainScope === 'vault') {
          setVaultStatusMessage((prev) => prev || `Synced ${stats.indexed_files} notes from ${cleanedPath}.`);
          setVaultSearchMeta((prev) => (prev ? {
            ...prev,
            indexedFiles: stats.indexed_files,
            indexedChunks: stats.indexed_chunks,
          } : prev));
        }
      })
      .catch((error) => {
        console.error('Incremental vault sync failed:', error);
        setVaultStatusMessage(`Incremental vault sync failed for ${toVaultRelativePath(cleanedPath)}. ${getErrorMessage(error)}`);
      })
      .finally(() => {
        pendingSubtreeSyncRef.current.delete(syncKey);
        if (refreshTree) {
          invalidateFileTreeCache(vaultPath);
          void loadFileTree(true);
        }
      });
  }, [brainScope, loadFileTree, vaultActionRoot, vaultPath]);

  const selectVault = async () => {
    if (!window.atheletiaAPI?.notes) {
      alert('Notes API not available. Make sure you are running in the Tauri desktop app.');
      return;
    }
    const path = await window.atheletiaAPI.notes.selectVault();
    if (path) {
      if (!areEquivalentPaths(path, vaultPath)) {
        await stopVaultReindex('Stopped previous vault indexing due to vault change.');
      }
      setVaultPath(path);
      localStorage.setItem('brain_vaultPath', path);
      setCreateTargetPath(path);
      setSelectedTreePath(null);
    }
  };

  const openFile = useCallback(async (filePath: string, force = false): Promise<boolean> => {
    if (!window.atheletiaAPI?.notes) return false;
    const content = !force
      ? getCachedFileContent(filePath) ?? await window.atheletiaAPI.notes.readFile(filePath)
      : await window.atheletiaAPI.notes.readFile(filePath);
    if (content !== null) {
      cacheFileContent(filePath, content);
      setSelectedFile(filePath);
      setSelectedTreePath(filePath);
      setCreateTargetPath(getParentDirectory(filePath) || vaultPath);
      localStorage.setItem('brain_selectedFile', filePath);
      setFileContent(content);
      setEditContent(content);
      setIsEditing(false);

      // Build breadcrumbs
      const relativePath = filePath.replace(vaultPath, '').replace(/^[/\\]/, '');
      const parts = relativePath.split(/[/\\]/);
      setBreadcrumbs(parts);
      return true;
    }
    return false;
  }, [vaultPath]);

  const resolveVaultDestinationDirectory = useCallback((rawDestinationPath?: string | null): string => {
    const raw = stripWindowsExtendedPathPrefix(rawDestinationPath || '').trim();
    if (!raw) {
      return getDirectoryForNodePath(createTargetPath || selectedTreePath || selectedFile, fileTree, vaultActionRoot);
    }

    const normalizedRaw = raw
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    const rootFolderName = (vaultActionRoot.split(/[\\/]/).pop() || '').toLowerCase();
    if (
      !normalizedRaw
      || normalizedRaw === '.'
      || normalizedRaw === '/'
      || normalizedRaw === 'root'
      || normalizedRaw === 'vault'
      || normalizedRaw === 'vault root'
      || normalizedRaw === 'root folder'
      || normalizedRaw === rootFolderName
    ) {
      return vaultActionRoot;
    }

    const candidate = isAbsoluteFilePath(raw)
      ? raw
      : joinFileSystemPath(vaultActionRoot, raw);
    if (candidate.toLowerCase().endsWith('.md')) {
      return getParentDirectory(candidate) || vaultActionRoot;
    }
    return candidate;
  }, [createTargetPath, fileTree, selectedFile, selectedTreePath, vaultActionRoot]);

  const toVaultRelativePath = useCallback((absolutePath: string): string => {
    const cleanedPath = stripWindowsExtendedPathPrefix(absolutePath || '').trim();
    if (!cleanedPath) return absolutePath;
    const cleanedRoot = stripWindowsExtendedPathPrefix(vaultActionRoot || '').trim().replace(/[\\/]+$/, '');
    if (!cleanedRoot) return cleanedPath;

    const relative = cleanedPath.replace(new RegExp(`^${escapeRegExp(cleanedRoot)}[\\\\/]*`, 'i'), '');
    return relative || '.';
  }, [vaultActionRoot]);

  const getVaultDirectoryCandidates = useCallback((max = 500): string[] => {
    return dedupeEquivalentPaths([
      ...(vaultActionRoot ? [vaultActionRoot] : []),
      ...collectDirectoryPaths(fileTree, max),
    ]).slice(0, Math.max(max, 1));
  }, [fileTree, vaultActionRoot]);

  const resolveVaultTargetPath = useCallback(async (rawTargetPath: string, destinationPath?: string | null): Promise<string | null> => {
    if (!window.atheletiaAPI?.notes) return null;

    const targetPath = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!targetPath) return null;

    const candidates: string[] = [];
    const pushCandidate = (value?: string | null) => {
      if (!value) return;
      const cleaned = stripWindowsExtendedPathPrefix(value).trim();
      if (!cleaned) return;
      if (candidates.some(existing => areEquivalentPaths(existing, cleaned))) return;
      candidates.push(cleaned);
    };
    const pushCandidateWithMarkdownFallback = (value?: string | null) => {
      if (!value) return;
      const cleaned = stripWindowsExtendedPathPrefix(value).trim();
      if (!cleaned) return;
      pushCandidate(cleaned);
      if (!/\.md$/i.test(cleaned)) {
        pushCandidate(`${cleaned}.md`);
      }
    };

    if (isAbsoluteFilePath(targetPath)) {
      pushCandidateWithMarkdownFallback(targetPath);
    } else {
      pushCandidateWithMarkdownFallback(joinFileSystemPath(vaultActionRoot, targetPath));
      if (destinationPath) {
        pushCandidateWithMarkdownFallback(joinFileSystemPath(resolveVaultDestinationDirectory(destinationPath), targetPath));
      }
    }

    const targetNormalized = targetPath
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .toLowerCase();
    if (targetNormalized) {
      const markdownCandidates = collectMarkdownPaths(fileTree, 320)
        .map(path => {
          const relativePath = toVaultRelativePath(path)
            .replace(/[\\/]+/g, '/')
            .toLowerCase();
          const fileName = (path.split(/[/\\]/).pop() || '').replace(/\.md$/i, '').toLowerCase();
          let score = 0;
          if (relativePath === targetNormalized) score += 10;
          if (fileName === targetNormalized) score += 8;
          if (relativePath.endsWith(`/${targetNormalized}`)) score += 6;
          if (relativePath.includes(targetNormalized)) score += 2;
          return { path, score };
        })
        .filter(item => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 8);

      for (const match of markdownCandidates) {
        pushCandidate(match.path);
      }
    }

    for (const candidate of candidates) {
      const content = await window.atheletiaAPI.notes.readFile(candidate);
      if (content !== null) {
        return candidate;
      }
    }

    return null;
  }, [fileTree, resolveVaultDestinationDirectory, toVaultRelativePath, vaultActionRoot]);

  const resolveVaultExistingNodePath = useCallback((rawTargetPath: string, destinationPath?: string | null): string | null => {
    const targetPath = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!targetPath) return null;

    const candidates: string[] = [];
    const pushCandidate = (value?: string | null) => {
      if (!value) return;
      const cleaned = stripWindowsExtendedPathPrefix(value).trim();
      if (!cleaned) return;
      if (candidates.some(existing => areEquivalentPaths(existing, cleaned))) return;
      candidates.push(cleaned);
    };

    if (isAbsoluteFilePath(targetPath)) {
      pushCandidate(targetPath);
    } else {
      pushCandidate(joinFileSystemPath(vaultActionRoot, targetPath));
      if (destinationPath) {
        pushCandidate(joinFileSystemPath(resolveVaultDestinationDirectory(destinationPath), targetPath));
      }
    }

    for (const candidate of candidates) {
      const node = findNodeByPath(fileTree, candidate);
      if (node) return node.path;
      if (!candidate.toLowerCase().endsWith('.md')) {
        const markdownCandidate = `${candidate}.md`;
        const markdownNode = findNodeByPath(fileTree, markdownCandidate);
        if (markdownNode) return markdownNode.path;
      }
    }

    const targetNormalized = targetPath
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!targetNormalized) return null;

    const rootFolderName = (vaultActionRoot.split(/[\\/]/).pop() || '').toLowerCase();
    const directoryMatch = getVaultDirectoryCandidates(600)
      .map(path => {
        const relativePath = toVaultRelativePath(path).replace(/[\\/]+/g, '/').toLowerCase();
        const folderName = (path.split(/[\\/]/).pop() || '').toLowerCase();
        let score = 0;
        if (relativePath === targetNormalized) score += 12;
        if (folderName === targetNormalized) score += 10;
        if (relativePath.endsWith(`/${targetNormalized}`)) score += 8;
        if (folderName.includes(targetNormalized)) score += 5;
        if (relativePath.includes(targetNormalized)) score += 3;
        if (path === vaultActionRoot) {
          if (targetNormalized === '.' || targetNormalized === 'root' || targetNormalized === 'vault' || targetNormalized === 'vault root' || targetNormalized === 'root folder') score += 14;
          if (rootFolderName && targetNormalized === rootFolderName) score += 12;
          if (rootFolderName && targetNormalized.includes(rootFolderName)) score += 6;
        }
        return { path, score };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score)[0];

    if (directoryMatch) {
      return directoryMatch.path;
    }

    const noteMatch = collectMarkdownPaths(fileTree, 600)
      .map(path => {
        const relativePath = toVaultRelativePath(path).replace(/[\\/]+/g, '/').replace(/\.md$/i, '').toLowerCase();
        const fileName = (path.split(/[\\/]/).pop() || '').replace(/\.md$/i, '').toLowerCase();
        let score = 0;
        if (relativePath === targetNormalized) score += 10;
        if (fileName === targetNormalized) score += 8;
        if (relativePath.endsWith(`/${targetNormalized}`)) score += 6;
        if (relativePath.includes(targetNormalized)) score += 2;
        return { path, score };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score)[0];

    return noteMatch?.path || null;
  }, [fileTree, getVaultDirectoryCandidates, resolveVaultDestinationDirectory, toVaultRelativePath, vaultActionRoot]);

  const suggestVaultNotePaths = useCallback((query: string, max = 4): string[] => {
    const normalizedQuery = stripWindowsExtendedPathPrefix(query || '')
      .trim()
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .toLowerCase();
    if (!normalizedQuery) return [];

    return collectMarkdownPaths(fileTree, 400)
      .map(path => {
        const relativePath = toVaultRelativePath(path).replace(/[\\/]+/g, '/').toLowerCase();
        const fileName = (path.split(/[/\\]/).pop() || '').replace(/\.md$/i, '').toLowerCase();
        let score = 0;
        if (relativePath === normalizedQuery) score += 10;
        if (fileName === normalizedQuery) score += 8;
        if (relativePath.endsWith(`/${normalizedQuery}`)) score += 6;
        if (relativePath.includes(normalizedQuery)) score += 2;
        return { path, score };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, max)
      .map(item => toVaultRelativePath(item.path));
  }, [fileTree, toVaultRelativePath]);

  const suggestVaultDirectoryPaths = useCallback((query: string, max = 6): string[] => {
    const normalizedQuery = stripWindowsExtendedPathPrefix(query || '')
      .trim()
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!normalizedQuery) return [];

    const rootFolderName = (vaultActionRoot.split(/[\\/]/).pop() || '').toLowerCase();
    return getVaultDirectoryCandidates(500)
      .map(path => {
        const relativePath = toVaultRelativePath(path).replace(/[\\/]+/g, '/').toLowerCase();
        const folderName = (path.split(/[/\\]/).pop() || '').toLowerCase();
        let score = 0;
        if (relativePath === normalizedQuery) score += 12;
        if (folderName === normalizedQuery) score += 10;
        if (relativePath.endsWith(`/${normalizedQuery}`)) score += 8;
        if (folderName.includes(normalizedQuery)) score += 6;
        if (relativePath.includes(normalizedQuery)) score += 4;
        if (path === vaultActionRoot) {
          if (normalizedQuery === '.' || normalizedQuery === 'root' || normalizedQuery === 'vault' || normalizedQuery === 'vault root' || normalizedQuery === 'root folder') score += 14;
          if (rootFolderName && normalizedQuery === rootFolderName) score += 12;
          if (rootFolderName && normalizedQuery.includes(rootFolderName)) score += 6;
        }
        return { path, score };
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, max)
      .map(item => item.path);
  }, [getVaultDirectoryCandidates, toVaultRelativePath, vaultActionRoot]);

  const collectMarkdownFilesForDirectory = useCallback((directoryPath: string, max = 80): string[] => {
    const cleanedDirectoryPath = stripWindowsExtendedPathPrefix(directoryPath || '').trim();
    if (!cleanedDirectoryPath) return [];

    const matchesVaultRoot = areEquivalentPaths(cleanedDirectoryPath, vaultActionRoot);
    const resolvedNode = matchesVaultRoot ? null : findNodeByPath(fileTree, cleanedDirectoryPath);

    let queue: FileNode[] = [];
    if (matchesVaultRoot) {
      queue = [...fileTree];
    } else if (resolvedNode?.isDirectory) {
      queue = [...(resolvedNode.children || [])];
    } else if (resolvedNode) {
      const parentPath = getParentDirectory(resolvedNode.path) || vaultActionRoot;
      if (areEquivalentPaths(parentPath, vaultActionRoot)) {
        queue = [...fileTree];
      } else {
        const parentNode = findNodeByPath(fileTree, parentPath);
        if (parentNode?.isDirectory) {
          queue = [...(parentNode.children || [])];
        }
      }
    } else {
      const fallbackParent = getParentDirectory(cleanedDirectoryPath);
      if (fallbackParent && areEquivalentPaths(fallbackParent, vaultActionRoot)) {
        queue = [...fileTree];
      } else if (fallbackParent) {
        const parentNode = findNodeByPath(fileTree, fallbackParent);
        if (parentNode?.isDirectory) {
          queue = [...(parentNode.children || [])];
        }
      }
    }

    if (!queue.length) return [];

    const discovered: string[] = [];
    while (queue.length > 0 && discovered.length < max) {
      const node = queue.shift();
      if (!node) break;
      if (node.isDirectory) {
        if (node.children?.length) {
          queue.push(...node.children);
        }
        continue;
      }
      if (isMarkdownPath(node.path)) {
        discovered.push(node.path);
      }
    }

    return discovered;
  }, [fileTree, vaultActionRoot]);

  const buildVaultOpenOptions = useCallback((absolutePaths: string[], maxOptions = 8): BrainChatOption[] => {
    const deduped: string[] = [];
    for (const path of absolutePaths) {
      if (!path) continue;
      if (deduped.some(existing => areEquivalentPaths(existing, path))) continue;
      deduped.push(path);
    }

    return deduped
      .slice(0, maxOptions)
      .map(path => {
        const relative = toVaultRelativePath(path);
        const rawLabel = (path.split(/[/\\]/).pop() || relative || path).replace(/\.md$/i, '');
        return {
          id: `open_note:${path}`,
          action: 'open_note' as const,
          value: path,
          label: rawLabel,
          description: relative,
        };
      });
  }, [toVaultRelativePath]);

  const pushVaultOpenChoiceMessage = useCallback((absolutePaths: string[], intro: string): boolean => {
    const deduped: string[] = [];
    for (const path of absolutePaths) {
      if (!path) continue;
      if (deduped.some(existing => areEquivalentPaths(existing, path))) continue;
      deduped.push(path);
    }

    if (!deduped.length) {
      return false;
    }

    const previewLimit = 12;
    const previewLines = deduped
      .slice(0, previewLimit)
      .map((path, index) => `${index + 1}. ${toVaultRelativePath(path)}`)
      .join('\n');
    const moreCount = deduped.length - previewLimit;

    setVaultMessages(prev => [...prev, {
      sender: 'ai',
      text: `${intro}\n\n${previewLines}${moreCount > 0 ? `\n...and ${moreCount} more.` : ''}\n\nChoose one file below to open it.`,
      options: buildVaultOpenOptions(deduped),
    }]);

    return true;
  }, [buildVaultOpenOptions, toVaultRelativePath]);

  const resolveVaultOpenChoicePaths = useCallback((rawTargetPath: string, destinationPath?: string | null, max = 24): string[] => {
    const cleanedTarget = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!cleanedTarget) return [];

    const collected: string[] = [];
    const pushFilePath = (candidate?: string | null) => {
      if (!candidate) return;
      const cleaned = stripWindowsExtendedPathPrefix(candidate).trim();
      if (!cleaned) return;
      if (!isMarkdownPath(cleaned)) return;
      if (collected.some(existing => areEquivalentPaths(existing, cleaned))) return;
      collected.push(cleaned);
    };

    const pushDirectoryFiles = (candidateDir?: string | null) => {
      if (!candidateDir || collected.length >= max) return;
      const cleaned = stripWindowsExtendedPathPrefix(candidateDir).trim();
      if (!cleaned) return;
      const files = collectMarkdownFilesForDirectory(cleaned, max - collected.length);
      for (const filePath of files) {
        pushFilePath(filePath);
      }
    };

    if (isAbsoluteFilePath(cleanedTarget)) {
      const node = findNodeByPath(fileTree, cleanedTarget);
      if (node?.isDirectory) {
        pushDirectoryFiles(cleanedTarget);
      } else {
        pushFilePath(cleanedTarget);
        const parent = getParentDirectory(cleanedTarget);
        if (parent) pushDirectoryFiles(parent);
      }
    } else {
      const rootCandidate = joinFileSystemPath(vaultActionRoot, cleanedTarget);
      const rootNode = findNodeByPath(fileTree, rootCandidate);
      if (rootNode?.isDirectory) {
        pushDirectoryFiles(rootCandidate);
      } else {
        pushFilePath(rootCandidate);
      }

      if (destinationPath) {
        const destinationCandidate = joinFileSystemPath(resolveVaultDestinationDirectory(destinationPath), cleanedTarget);
        const destinationNode = findNodeByPath(fileTree, destinationCandidate);
        if (destinationNode?.isDirectory) {
          pushDirectoryFiles(destinationCandidate);
        } else {
          pushFilePath(destinationCandidate);
        }
      }
    }

    for (const directoryPath of suggestVaultDirectoryPaths(cleanedTarget, 6)) {
      pushDirectoryFiles(directoryPath);
      if (collected.length >= max) break;
    }

    if (!collected.length) {
      const noteSuggestions = suggestVaultNotePaths(cleanedTarget, Math.min(max, 10));
      for (const notePath of noteSuggestions) {
        pushFilePath(joinFileSystemPath(vaultActionRoot, notePath));
      }
    }

    return collected.slice(0, max);
  }, [collectMarkdownFilesForDirectory, fileTree, resolveVaultDestinationDirectory, suggestVaultDirectoryPaths, suggestVaultNotePaths, vaultActionRoot]);

  const buildVaultAnswerOptionsFromPaths = useCallback((paths: string[], instructionPrefix: string, maxOptions = 6): BrainChatOption[] => {
    return dedupeEquivalentPaths(paths)
      .slice(0, maxOptions)
      .map((path, index) => {
        const relative = toVaultRelativePath(path);
        const fileOrFolder = path.split(/[\\/]/).pop() || relative || path;
        return {
          id: `${instructionPrefix}:${index}`,
          action: 'answer_question' as const,
          value: `${instructionPrefix}: ${relative}`,
          label: relative,
          description: fileOrFolder,
        };
      });
  }, [toVaultRelativePath]);

  const resolveVaultFilePathWithConfidence = createResolveVaultFilePathWithConfidence({ stripWindowsExtendedPathPrefix, resolveVaultTargetPath, resolveVaultOpenChoicePaths, suggestVaultNotePaths, isAbsoluteFilePath, joinFileSystemPath, vaultActionRoot, dedupeEquivalentPaths, toVaultRelativePath, areEquivalentPaths });

  const resolveVaultNodePathWithConfidence = createResolveVaultNodePathWithConfidence({ stripWindowsExtendedPathPrefix, resolveVaultExistingNodePath, suggestVaultNotePaths, isAbsoluteFilePath, joinFileSystemPath, vaultActionRoot, suggestVaultDirectoryPaths, dedupeEquivalentPaths, areEquivalentPaths });

  const resolveVaultDestinationWithConfidence = createResolveVaultDestinationWithConfidence({ stripWindowsExtendedPathPrefix, resolveVaultDestinationDirectory, findNodeByPath, fileTree, suggestVaultDirectoryPaths, dedupeEquivalentPaths });

  const pushVaultClarificationQuestion = createPushVaultClarificationQuestion({ setVaultMessages });

  const extractVaultFolderListQuery = useCallback((input: string): string | null => {
    const text = (input || '').trim();
    if (!text) return null;

    const patterns = [
      /(?:open|show|list)\s+(?:all\s+)?(?:files|notes)(?:\s+that\s+are|\s+are|\s+present)?\s+(?:in|inside|under)\s+(.+)$/i,
      /(?:what|which|list|show)\s+(?:all\s+)?(?:files|notes)(?:\s+are\s+present|\s+are|\s+that are|\s+present)?\s+(?:in|inside|under)\s+(.+)$/i,
      /(?:files|notes)\s+(?:in|inside|under)\s+(.+)$/i,
      /(?:in|inside|under)\s+(.+)\s+(?:what|which)\s+(?:files|notes)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const cleaned = match[1]
          .replace(/[?!.]+$/g, '')
          .replace(/^the\s+folder\s+/i, '')
          .replace(/^folder\s+/i, '')
          .replace(/^"|"$/g, '')
          .replace(/^'|'$/g, '')
          .trim();
        if (cleaned) return cleaned;
      }
    }

    return null;
  }, []);

  const tryHandleVaultMultiFileChainIntent = createTryHandleVaultMultiFileChainIntent({ extractVaultFolderListQuery, loadFileTree, resolveVaultDestinationDirectory, resolveVaultDestinationWithConfidence, syncVaultSubtreeInBackground, toVaultRelativePath, vaultActionRoot, vaultMultiFileChain, vaultPath, setVaultMultiFileChain, setVaultMessages, setVaultStatusMessage, isMultiFileVaultIntent, extractVaultDestinationHint, areEquivalentPaths, isMultiFileChainDoneSignal, parseMultiFileInstruction, normalizeMarkdownFileName, sanitizeProposedMarkdown, buildMultiFileStarterMarkdown, invalidateFileTreeCache });

  const tryHandleVaultFileListIntent = createTryHandleVaultFileListIntent({ collectMarkdownFilesForDirectory, extractVaultFolderListQuery, fileTree, pushVaultOpenChoiceMessage, selectedDirectoryPath, selectedFile, suggestVaultDirectoryPaths, toVaultRelativePath, vaultActionRoot, vaultPath, isBulkVaultOpenIntent, isVaultInventoryIntent, getDirectoryForNodePath, setVaultMessages });

  const handleVaultMessageOptionSelect = createHandleVaultMessageOptionSelect({ setVaultMessages, collectMarkdownFilesForDirectory, toVaultRelativePath, pushVaultOpenChoiceMessage, resolveVaultTargetPath, setBrainScope, openFile });

  // Load file tree on mount
  useEffect(() => {
    loadFileTree();
    if (selectedFile) {
      openFile(selectedFile);
    }
  }, [loadFileTree, openFile, selectedFile]);

  const saveFile = async () => {
    if (!selectedFile || !window.atheletiaAPI?.notes) return;
    const success = await window.atheletiaAPI.notes.writeFile(selectedFile, editContent);
    if (success) {
      cacheFileContent(selectedFile, editContent);
      setFileContent(editContent);
      setIsEditing(false);
      syncVaultSubtreeInBackground(selectedFile);
    }
  };

  // Handle checkbox toggle in read mode
  const handleCheckboxToggle = useCallback(async (lineIndex: number, checked: boolean) => {
    if (!selectedFile || !window.atheletiaAPI?.notes) return;

    // Optimistic Update: Update UI immediately
    const lines = fileContent.split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    const line = lines[lineIndex];
    let newLine: string;

    // Toggle carefully using regex to preserve other text
    if (checked) {
      // Replace first occurrence of [ ] with [x]
      newLine = line.replace(/\[([ ])\]/, '[x]');
    } else {
      // Replace first occurrence of [x] or [X] with [ ]
      newLine = line.replace(/\[([xX])\]/, '[ ]');
    }

    lines[lineIndex] = newLine;
    const newContent = lines.join('\n');

    // Update State Instantly
    setFileContent(newContent);
    setEditContent(newContent);
    cacheFileContent(selectedFile, newContent);

    // Save to disk in background
    const wrote = await window.atheletiaAPI.notes.writeFile(selectedFile, newContent);
    if (wrote) {
      syncVaultSubtreeInBackground(selectedFile);
    }
  }, [selectedFile, fileContent, syncVaultSubtreeInBackground]);

  const createNewFile = async () => {
    if (!newFileName.trim() || !window.atheletiaAPI?.notes) return;
    const result = await window.atheletiaAPI.notes.createFile(selectedDirectoryPath, normalizeMarkdownFileName(newFileName));
    if (result.success && result.path) {
      setShowNewFileInput(false);
      setNewFileName('');
      invalidateFileTreeCache(vaultPath);
      await loadFileTree();
      syncVaultSubtreeInBackground(result.path);
      openFile(result.path);
    }
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const createNewFolder = async () => {
    if (!newFolderName.trim() || !window.atheletiaAPI?.notes) return;
    const result = await window.atheletiaAPI.notes.createFolder(selectedDirectoryPath, newFolderName.trim());
    if (result.success) {
      setShowNewFolderInput(false);
      setNewFolderName('');
      invalidateFileTreeCache(vaultPath);
      await loadFileTree();
      syncVaultSubtreeInBackground(result.path || selectedDirectoryPath);
    }
  };

  const runFileDrop = createHandleFileDrop({ findNodeByPath, fileTree, resolveVaultTargetPath, isMarkdownPath, resolveVaultDestinationDirectory, getParentDirectory, areEquivalentPaths, pathIsWithin, invalidateFileTreeCache, vaultPath, syncVaultSubtreeInBackground, loadFileTree, selectedFile, openFile });
  const handleFileDrop = async (sourcePath: string, targetPath: string) => {
    const result = await runFileDrop(sourcePath, targetPath);
    if (result.success) {
      setVaultStatusMessage(result.newPath ? `Moved to ${toVaultRelativePath(result.newPath)}.` : 'Moved item.');
    } else if (result.error) {
      setVaultStatusMessage(result.error);
    }
    return result;
  };

  const handleRename = async (oldPath: string, newName: string) => {
    if (!window.atheletiaAPI?.notes) return;
    const safeName = oldPath.toLowerCase().endsWith('.md') ? normalizeMarkdownFileName(newName) : newName.trim();
    const oldParent = getParentDirectory(oldPath) || vaultPath;
    const result = await window.atheletiaAPI.notes.rename(oldPath, safeName);
    if (result.success) {
      invalidateFileTreeCache(vaultPath);
      syncVaultSubtreeInBackground(oldParent);
      syncVaultSubtreeInBackground(getParentDirectory(result.newPath || oldPath) || vaultPath);
      await loadFileTree();
      // If the renamed file was selected, update selection
      if (selectedFile === oldPath && result.newPath) {
        openFile(result.newPath, true);
      }
      if (selectedTreePath === oldPath && result.newPath) {
        setSelectedTreePath(result.newPath);
      }
      if (createTargetPath === oldPath && result.newPath) {
        setCreateTargetPath(result.newPath);
      }
    } else {
      console.error('Rename failed:', result.error);
      setVaultStatusMessage(`Rename failed. ${result.error || 'Unknown rename failure.'}`);
    }
  };

  const handleSelectTreeNode = useCallback((path: string, isDirectory: boolean) => {
    setSelectedTreePath(path);
    if (isDirectory) {
      setCreateTargetPath(path);
      return;
    }
    setCreateTargetPath(getParentDirectory(path) || vaultPath);
    openFile(path);
  }, [openFile, vaultPath]);

  const handleStopAi = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    window.atheletiaAPI?.settings?.brainCancelStream?.().catch((error: unknown) => {
      console.error('Failed to cancel Brain stream:', error);
      setVaultStatusMessage(`Failed to cancel Brain stream. ${getErrorMessage(error)}`);
    });
    setStreamingMsgIndex(null);
    setIsAiLoading(false);
    // Remove the interrupted AI message instead of adding an interruption message
    setCurrentMessages(prev => {
      const lastMessage = prev[prev.length - 1];
      if (lastMessage && lastMessage.sender === 'ai' && lastMessage.text === '') {
        return prev.slice(0, -1);
      }
      return prev;
    });
  };

  const clearChat = () => {
    const nextMessages = brainScope === 'vault'
      ? [{ sender: 'ai' as const, text: 'Vault chat cleared. Ask anything across your markdown vault.' }]
      : [{ sender: 'ai' as const, text: 'Chat cleared. How can I help you with this note?' }];
    setCurrentMessages(nextMessages);
    const chatKey = brainScope === 'vault' ? vaultChatRef.current : `brain_chat_${chatFileRef.current}`;
    localStorage.removeItem(chatKey);
  };

  const buildBrainVaultContext = createBuildBrainVaultContext({ selectedFile, selectedTreePath, toVaultRelativePath, isVaultPathActionIntent, suggestVaultDirectoryPaths, suggestVaultNotePaths, vaultPath, vaultActionRoot });

  const handleAiSend = createHandleAiSend({
    isAiLoading, brainScope, vaultPath, setCurrentMessages, aiProvider, selectedProvider: effectiveSelectedProvider, apiKey: effectiveApiKey, nvidiaApiKey: effectiveApiKey, abortControllerRef,
    selectedContext, selectionRange, tiptapRange, isEditing, setSelectedContext, setTiptapRange,
    setSelectionRange, setIsAiLoading, setProposedAction, setVaultSearchMeta, setIsVaultSearchLoading,
    setVaultStatusMessage, tryHandleVaultMultiFileChainIntent, tryHandleVaultFileListIntent, editContent,
    fileContent, availableModels: allModels, selectedModel, DEFAULT_NIM_MODEL, buildBrainVaultContext, aiMode,
    selectedFile, buildBrainNoteContext, buildModelConversation, currentMessages, setStreamingMsgIndex,
    sanitizeVisibleBrainResponse, parseActionPayload, normalizeClarificationOptions, isExplicitWholeRewriteIntent,
    sanitizeProposedMarkdown, inferActionContentFromResponse, requestsCreateAndWriteInVault, extractRequestedNoteTitle,
    resolveVaultDestinationWithConfidence, vaultActionRoot, isBulkVaultOpenIntent, resolveVaultDestinationDirectory,
    selectedDirectoryPath, getDirectoryForNodePath, fileTree, collectMarkdownFilesForDirectory, toVaultRelativePath,
    buildVaultOpenOptions, buildVaultAnswerOptionsFromPaths, collectMarkdownPaths, getVaultDirectoryCandidates,
    resolveVaultFilePathWithConfidence, resolveVaultNodePathWithConfidence, buildBrainActionPreview,
    suggestVaultNotePaths, getErrorMessage, looksLikeClarificationQuestion, isAmbiguousOperationRequest, normalizeMarkdownFileName,
  });

  const submitClarificationAnswer = createSubmitClarificationAnswer({ isAiLoading, brainScope, setVaultMessages, setAiMessages, handleAiSend });

  const handleChatOptionSelect = createHandleChatOptionSelect({ submitClarificationAnswer, brainScope, handleVaultMessageOptionSelect });

  const handleChatFreeTextReply = createHandleChatFreeTextReply({ submitClarificationAnswer });

  const handleApplyAction = createHandleApplyAction({
    proposedAction, normalizeMarkdownFileName, resolveVaultDestinationDirectory, setVaultMessages, toVaultRelativePath,
    invalidateFileTreeCache, vaultPath, syncVaultSubtreeInBackground, loadFileTree, setBrainScope, openFile,
    resolveVaultTargetPath, resolveVaultOpenChoicePaths, pushVaultOpenChoiceMessage, suggestVaultNotePaths,
    sanitizeProposedMarkdown, escapeRegExp, pushVaultClarificationQuestion, extractMarkdownHeadingTitles,
    cacheFileContent, selectedFile, areEquivalentPaths, setFileContent, setEditContent, joinFileSystemPath,
    handleFileDrop, vaultActionRoot, resolveVaultExistingNodePath, suggestVaultDirectoryPaths, getParentDirectory,
    pathIsWithin, setSelectedFile, setSelectedTreePath, setCreateTargetPath, setIsEditing, selectedDirectoryPath,
    setAiMessages, isEditing, editContent, fileContent, editorRef, isUiTranscriptNoise, setPreviousContent,
    stripWindowsExtendedPathPrefix, setProposedAction, getErrorMessage,
  });

  // Handle Revert
  const handleRevertAction = createHandleRevertAction({ previousContent, selectedFile, syncVaultSubtreeInBackground, setFileContent, setEditContent, isEditing, editorRef, setAiMessages, setPreviousContent, setVaultStatusMessage });

  // Sidebar States
  const [isExplorerOpen, setIsExplorerOpen] = useState(true);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(true);

  return (
    <div className="flex h-full w-full bg-[#0a0a0a] text-white overflow-hidden animate-in fade-in duration-300 relative">

      {/* LEFT COLUMN: FILE EXPLORER */}
      {isExplorerOpen && (
        <div className="w-64 bg-[#161616] border-r border-[#262626] flex flex-col shrink-0 animate-in slide-in-from-left-10 duration-200">
          <div className="h-12 flex items-center justify-between px-4 border-b border-[#262626]">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">Explorer</span>
            <div className="flex gap-1">
              <button onClick={() => setIsExplorerOpen(false)} className="p-1 hover:bg-[#262626] rounded text-gray-500 hover:text-white" title="Close Explorer">
                <PanelLeftClose size={14} />
              </button>
            </div>
          </div>


          {showNewFileInput && (
            <div className="p-2 border-b border-[#262626]">
              <input
                autoFocus
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createNewFile();
                  if (e.key === 'Escape') setShowNewFileInput(false);
                }}
                placeholder="New note name..."
                className="w-full px-2 py-1 bg-[#262626] border border-[#333] rounded text-sm text-white outline-none focus:border-purple-500"
              />
            </div>
          )}

          {showNewFolderInput && (
            <div className="p-2 border-b border-[#262626]">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createNewFolder();
                  if (e.key === 'Escape') setShowNewFolderInput(false);
                }}
                placeholder="New folder name..."
                className="w-full px-2 py-1 bg-[#262626] border border-[#333] rounded text-sm text-white outline-none focus:border-yellow-500"
              />
            </div>
          )}

          <div className="flex-1 overflow-y-auto py-3 px-2 flex flex-col gap-0.5 custom-scrollbar">
            {fileTree.length === 0 ? (
              <div className="text-center text-gray-500 text-sm py-4">
                {window.atheletiaAPI?.notes ? 'Loading...' : 'Run in Tauri desktop app to access files'}
              </div>
            ) : (
              fileTree.map(node => (
                <FileTreeItemReal
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedTreePath}
                  onSelect={handleSelectTreeNode}
                  expandedFolders={expandedFolders}
                  toggleFolder={toggleFolder}
                  onDrop={handleFileDrop}
                  onRename={handleRename}
                />
              ))
            )}
          </div>

          <div className="flex items-center gap-1 p-2 border-t border-[#262626]">
            <button onClick={() => loadFileTree(true)} className="p-1.5 hover:bg-[#262626] rounded text-gray-500 hover:text-white" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button onClick={() => { setShowNewFileInput(true); setShowNewFolderInput(false); }} className="p-1.5 hover:bg-[#262626] rounded text-gray-500 hover:text-white" title="New Note">
              <FilePlus size={14} />
            </button>
            <button onClick={() => { setShowNewFolderInput(true); setShowNewFileInput(false); }} className="p-1.5 hover:bg-[#262626] rounded text-gray-500 hover:text-white" title="New Folder">
              <FolderOpen size={14} />
            </button>
            <button
              onClick={selectVault}
              className="flex-1 ml-1 px-2 py-1.5 bg-[#262626] border border-[#333] rounded text-xs text-center text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
            >
              Change Vault
            </button>
          </div>
          <div className="px-2 pb-2 text-[10px] text-gray-500 border-t border-[#262626]">
            <div className="truncate">Create in: {selectedDirectoryPath.replace(vaultPath, '').replace(/^[/\\]/, '') || '.'}</div>
          </div>
        </div>
      )}

      {/* CENTER COLUMN: EDITOR */}
      <div className="flex-1 flex flex-col bg-[#0a0a0a] relative min-w-0">
        {/* Header / Breadcrumbs */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-[#262626]">
          <div className="flex items-center gap-3 overflow-hidden">
            {!isExplorerOpen && (
              <button onClick={() => setIsExplorerOpen(true)} className="p-1 hover:bg-[#262626] rounded text-gray-500 hover:text-white" title="Open Explorer">
                <PanelLeftOpen size={16} />
              </button>
            )}

            <div className="flex items-center text-sm text-gray-500 select-none overflow-hidden text-ellipsis whitespace-nowrap">
              {breadcrumbs.length > 0 ? (
                breadcrumbs.map((crumb, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <ChevronRight size={14} className="mx-2 opacity-50 shrink-0" />}
                    <span className={`truncate ${i === breadcrumbs.length - 1 ? 'text-gray-300' : 'hover:text-gray-300 cursor-pointer transition-colors'}`}>
                      {crumb.replace('.md', '')}
                    </span>
                  </React.Fragment>
                ))
              ) : (
                <span className="text-gray-600">No note selected</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Notes font size controls */}
            {selectedFile && (
              <div className="flex items-center gap-0.5 mr-1">
                <button
                  onClick={() => setNotesFontSize(prev => { const v = Math.max(12, prev - 1); localStorage.setItem('brain_notesFontSize', String(v)); return v; })}
                  className="p-1 hover:bg-[#262626] rounded text-gray-500 hover:text-white transition-colors"
                  title="Decrease font size"
                  disabled={notesFontSize <= 12}
                >
                  <Minus size={12} />
                </button>
                <span className="text-[10px] text-gray-500 font-mono w-7 text-center select-none">{notesFontSize}</span>
                <button
                  onClick={() => setNotesFontSize(prev => { const v = Math.min(28, prev + 1); localStorage.setItem('brain_notesFontSize', String(v)); return v; })}
                  className="p-1 hover:bg-[#262626] rounded text-gray-500 hover:text-white transition-colors"
                  title="Increase font size"
                  disabled={notesFontSize >= 28}
                >
                  <Plus size={12} />
                </button>
              </div>
            )}
            {selectedFile && (
              <>
                {isEditing ? (
                  <>
                    <button onClick={saveFile} className="flex items-center gap-1 px-3 py-1 bg-green-600 rounded text-xs text-white hover:bg-green-500">
                      <Save size={12} /> <span className="hidden sm:inline">Save</span>
                    </button>
                    <button onClick={() => { setIsEditing(false); setEditContent(fileContent); }} className="flex items-center gap-1 px-3 py-1 bg-[#262626] rounded text-xs text-gray-300 hover:bg-[#333]">
                      Cancel
                    </button>
                  </>
                ) : (
                  <button onClick={() => setIsEditing(true)} className="flex items-center gap-1 px-3 py-1 bg-[#262626] rounded text-xs text-gray-300 hover:bg-[#333]">
                    <Edit3 size={12} /> <span className="hidden sm:inline">Edit</span>
                  </button>
                )}
              </>
            )}

            {!isAiPanelOpen && (
              <button onClick={() => setIsAiPanelOpen(true)} className="p-1 hover:bg-[#262626] rounded text-gray-500 hover:text-white ml-2" title="Open AI">
                <PanelRightOpen size={16} />
              </button>
            )}
          </div>
        </div>

        {showVaultProgressInHeader && (
          <div className="px-4 py-1.5 border-b border-cyan-900/30 bg-cyan-500/5">
            <div className="h-1.5 rounded-full bg-[#0f1a1f] border border-cyan-900/40 overflow-hidden">
              <div className="h-full bg-cyan-400 transition-all duration-200" style={{ width: `${vaultIndexPercent}%` }} />
            </div>
            <div className="mt-1 text-[10px] text-cyan-200/80 truncate">
              {vaultIndexProgress && vaultIndexProgress.total_files > 0
                ? `Indexing ${vaultIndexProgress.processed_files}/${vaultIndexProgress.total_files}`
                : 'Indexing markdown vault...'}
            </div>
          </div>
        )}

        {vaultStatusMessage && (
          <div className="px-4 pt-3">
            <StatusBanner
              tone={getVaultStatusTone(vaultStatusMessage)}
              title="Brain status"
              message={vaultStatusMessage}
              action={
                <button
                  onClick={() => setVaultStatusMessage('')}
                  className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-gray-200 hover:bg-white/5"
                >
                  Dismiss
                </button>
              }
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto custom-scrollbar bg-[#0a0a0a]" style={{ fontSize: `${notesFontSize}px` }}>
          {selectedFile ? (
            <div className="w-full h-full">
              {isEditing ? (
                <TiptapEditor
                  content={editContent}
                  onChange={(val) => setEditContent(val)}
                  onEditorCreate={(editor) => { editorRef.current = editor; }}
                  onSelectionChange={setSelectedContext}
                  onSelectionRangeChange={setTiptapRange}
                />
              ) : (
                <div
                  ref={markdownContainerRef}
                  onMouseUp={handleMouseUp}
                  className="prose prose-invert max-w-none w-full px-4 sm:px-8 pb-8 pt-4 cursor-auto select-text"
                >
                  <MarkdownRenderer content={fileContent} onCheckboxToggle={handleCheckboxToggle} />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <FileText size={48} className="mb-4 opacity-30" />
              <p>Select a note to view</p>
            </div>
          )}
        </div>
      </div>

      {/* DRAG HANDLE */}
      {isAiPanelOpen && (
        <div
          onMouseDown={startResizing}
          className={`w-1 hover:w-1.5 bg-[#262626] hover:bg-purple-500/50 cursor-col-resize z-dropdown transition-colors duration-150 ${isResizing ? 'bg-purple-500 w-1.5' : ''}`}
          style={{ touchAction: 'none' }}
        />
      )}

      {/* RIGHT COLUMN: Atheletia AI */}
      {isAiPanelOpen && (
        <div
          ref={sidebarRef}
          style={{ width: aiPanelWidth, willChange: isResizing ? 'width' : 'auto' }}
          className="bg-[#161616] border-l border-[#262626] flex flex-col shrink-0 animate-in slide-in-from-right-10 duration-200"
        >
          <div className="h-12 flex items-center justify-between px-5 border-b border-[#262626]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex items-center gap-2 shrink-0">
                <Sparkles size={16} className="text-purple-400 fill-purple-400/20" />
                <span className="font-semibold text-sm tracking-wide text-gray-200">Atheletia AI</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex p-0.5 bg-[#0a0a0a] rounded-md border border-[#262626] min-w-[154px]">
                  <button
                    onClick={() => { setBrainScope('note'); setProposedAction(null); }}
                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[11px] font-medium transition-all ${brainScope === 'note' ? 'bg-[#262626] text-cyan-300' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    <FileText size={12} />
                    Note
                  </button>
                  <button
                    onClick={() => { setBrainScope('vault'); setProposedAction(null); }}
                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[11px] font-medium transition-all ${brainScope === 'vault' ? 'bg-[#262626] text-purple-400' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    <FolderOpen size={12} />
                    Vault
                  </button>
                </div>
                {brainScope === 'vault' && (
                  <button
                    onClick={() => { void handleManualVaultReindex(); }}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors ${isVaultReindexing
                      ? 'bg-cyan-900/20 border-cyan-700/70 text-cyan-200 hover:bg-cyan-900/40'
                      : 'bg-[#262626] border-[#333] text-gray-300 hover:bg-[#333]'}`}
                    title={isVaultReindexing ? 'Stop indexing' : 'Rebuild vault index'}
                    style={{ marginLeft: 4 }}
                  >
                    {isVaultReindexing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    <span className="hidden sm:inline">{isVaultReindexing ? 'Stop' : 'Reindex'}</span>
                  </button>
                )}
              </div>
            </div>
            <button onClick={() => setIsAiPanelOpen(false)} className="text-gray-500 cursor-pointer hover:text-white transition-colors">
              <PanelRightClose size={14} />
            </button>
          </div>

          <div className="px-5 pt-3 pb-2 border-b border-[#262626] flex items-center gap-2">
            <div className="relative" ref={modelPopupRef}>
              <button
                onClick={() => setShowModelDropdown((prev) => !prev)}
                className="flex items-center gap-2 px-2.5 py-1.5 bg-[#0f0f0f] border border-[#333] rounded text-xs text-gray-300 hover:border-purple-500/40 transition-colors"
                title="Select model"
              >
                {aiProvider === 'lmstudio' || aiProvider === 'local'
                  ? <Cpu size={12} className="text-emerald-400 shrink-0" />
                  : <Cloud size={12} className="text-blue-400 shrink-0" />}
                <span className="max-w-[120px] truncate">{selectedModelDisplayName}</span>
                <ChevronDown size={12} className={`transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showModelDropdown && (
                <div className="absolute z-dropdown right-0 mt-2 w-[320px] max-w-[calc(100vw-3rem)] bg-[#151515] border border-[#333] rounded-lg shadow-xl overflow-hidden">
                  <div className="p-2 border-b border-[#2b2b2b]">
                    <div className="flex p-1 bg-[#0a0a0a] rounded-md border border-[#262626]">
                      <button
                        onClick={() => switchProvider('nvidia')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-xs font-medium transition-all ${aiProvider === 'nvidia' ? 'bg-[#262626] text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
                      >
                        <Cloud size={12} />
                        Cloud
                      </button>
                      <button
                        onClick={() => switchProvider('lmstudio')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-xs font-medium transition-all ${aiProvider === 'lmstudio' || aiProvider === 'local' ? 'bg-[#262626] text-emerald-400' : 'text-gray-500 hover:text-gray-300'}`}
                      >
                        <Cpu size={12} />
                        Local
                      </button>
                    </div>
                  </div>

                  {(aiProvider === 'lmstudio' || aiProvider === 'local') && (
                    <div className="px-3 py-2 border-b border-[#2b2b2b] flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">LM Studio</p>
                        <p className={`text-[10px] ${lmStudioError ? 'text-red-400' : 'text-gray-500'}`}>
                          {lmStudioError ? 'Offline' : lmStudioModels.length > 0 ? `${lmStudioModels.length} loaded` : 'Online'}
                        </p>
                      </div>
                      <button onClick={fetchLMStudioModels} className="text-gray-400 hover:text-white transition-colors p-1" title="Refresh">
                        {lmStudioLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      </button>
                    </div>
                  )}

                  <div className="p-2 border-b border-[#2b2b2b]">
                    <input
                      type="text"
                      value={modelSearchQuery}
                      onChange={(e) => setModelSearchQuery(e.target.value)}
                      placeholder="Search models..."
                      className="w-full px-3 py-2 bg-[#262626] border border-[#333] rounded text-sm text-gray-300 placeholder-gray-500 focus:outline-none focus:border-purple-500/40"
                      autoFocus
                    />
                  </div>

                  {(aiProvider === 'lmstudio' || aiProvider === 'local') && lmStudioError && (
                    <div className="px-3 py-3 text-center border-b border-[#2b2b2b]">
                      <p className="text-xs text-red-400">{lmStudioError}</p>
                      <p className="text-[10px] text-gray-500 mt-1">Make sure LM Studio is running with the server enabled</p>
                    </div>
                  )}

                  <div className="max-h-72 overflow-y-auto custom-scrollbar">
                    {modelsLoading || lmStudioLoading || cloudLoading ? (
                      <div className="px-3 py-3 flex items-center justify-center gap-2">
                        <Loader2 size={14} className="animate-spin text-purple-400" />
                        <span className="text-sm text-gray-500">Loading models...</span>
                      </div>
                    ) : (aiProvider === 'lmstudio' || aiProvider === 'local') ? (
                      allModels
                        .filter(model => {
                          const searchLower = modelSearchQuery.toLowerCase();
                          return (model.name || model.id).toLowerCase().includes(searchLower)
                            || model.id.toLowerCase().includes(searchLower);
                        })
                        .map(model => (
                          <button
                            key={model.id}
                            onClick={() => {
                              setSelectedModel(model.id);
                              setSelectedProvider('local');
                              setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, model.id, 'local');
                              setShowModelDropdown(false);
                              setModelSearchQuery('');
                            }}
                            className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm hover:bg-[#262626] transition-colors ${selectedModel === model.id ? 'bg-purple-900/30 text-purple-300' : 'text-gray-300'}`}
                          >
                            <Cpu size={13} className="shrink-0 text-emerald-400/60" />
                            <span className="truncate">{model.name || model.id}</span>
                          </button>
                        ))
                    ) : (
                      (() => {
                        const filteredGroups = cloudGroups.map(group => ({
                          ...group,
                          models: group.models.filter(model => {
                            const searchLower = modelSearchQuery.toLowerCase();
                            return (model.name || model.id).toLowerCase().includes(searchLower)
                              || model.id.toLowerCase().includes(searchLower);
                          })
                        })).filter(g => g.models.length > 0);
                        if (filteredGroups.length === 0) {
                          return (
                            <div className="px-3 py-4 text-center">
                              <p className="text-xs text-gray-500">No matching models</p>
                              <p className="text-[10px] text-gray-600 mt-1">Type a model ID below to use any model</p>
                            </div>
                          );
                        }
                        return filteredGroups.map(group => (
                          <div key={group.provider} className="border-b border-[#333]/30 last:border-b-0">
                            <div className="px-3 py-1.5 bg-white/5">
                              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{group.label}</p>
                            </div>
                            {group.models.map(model => (
                              <button
                                key={model.id}
                                onClick={() => {
                                  setSelectedModel(model.id);
                                  setSelectedProvider(group.provider);
                                  setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, model.id, group.provider);
                                  setShowModelDropdown(false);
                                  setModelSearchQuery('');
                                }}
                                className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm hover:bg-[#262626] transition-colors ${selectedModel === model.id ? 'bg-purple-900/30 text-purple-300' : 'text-gray-300'}`}
                              >
                                <Cloud size={13} className="shrink-0 text-blue-400/60" />
                                <span className="truncate">{model.name || model.id}</span>
                              </button>
                            ))}
                          </div>
                        ));
                      })()
                    )}
                  </div>
                  {/* Custom model ID input — for non-NVIDIA or any provider */}
                  {aiProvider !== 'lmstudio' && aiProvider !== 'local' && (
                    <div className="px-3 py-2 border-t border-[#2b2b2b]">
                      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Use Any Model ID</p>
                      <div className="flex items-center gap-1.5">
                        <input
                          value={modelSearchQuery}
                          onChange={(e) => setModelSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && modelSearchQuery.trim()) {
                              e.preventDefault();
                              const inferred = inferProviderFromModel(modelSearchQuery.trim());
                              setSelectedModel(modelSearchQuery.trim());
                              setSelectedProvider(inferred);
                              setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, modelSearchQuery.trim(), inferred);
                              setShowModelDropdown(false);
                              setModelSearchQuery('');
                            }
                          }}
                          placeholder="e.g. gemini-2.0-flash"
                          className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-2 py-1.5 text-[11px] text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-500/40"
                        />
                        <button
                          onClick={() => {
                            if (modelSearchQuery.trim()) {
                              const inferred = inferProviderFromModel(modelSearchQuery.trim());
                              setSelectedModel(modelSearchQuery.trim());
                              setSelectedProvider(inferred);
                              setStoredModelWithProvider(BRAIN_LAST_MODEL_STORAGE_KEY, modelSearchQuery.trim(), inferred);
                              setShowModelDropdown(false);
                              setModelSearchQuery('');
                            }
                          }}
                          className="px-2.5 py-1.5 rounded bg-purple-600 text-[11px] text-white hover:bg-purple-500 transition-colors"
                        >
                          Use
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {showVaultIndexDoneMark && (
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-emerald-700/60 bg-emerald-900/20 text-emerald-300" title="Vault indexing complete">
                <Check size={12} />
              </span>
            )}

            <div className="ml-auto flex items-center gap-3">
              {previousContent && (
                <button
                  onClick={handleRevertAction}
                  className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-yellow-500 hover:text-yellow-400 transition-colors"
                  title="Undo last AI action"
                >
                  <RefreshCw size={12} /> Undo AI Edit
                </button>
              )}
              <button
                onClick={clearChat}
                className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-gray-500 hover:text-red-400 transition-colors"
                title="Clear current chat history"
              >
                <Trash2 size={12} /> Clear Chat
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col px-5 pb-4 pt-3 overflow-hidden">
            {brainScope === 'note' && selectedFile && (
              <div className="mb-2 space-y-2">
                <div className="flex items-center gap-2 rounded border border-[#2f2f2f] bg-[#101010] px-2 py-1.5 text-[11px] text-gray-300">
                  <FileText size={11} className="text-cyan-400 shrink-0" />
                  <span className="truncate">{selectedFile.split(/[/\\]/).pop()}</span>
                </div>
                {mcqSets.length > 0 && (
                  <div className="rounded border border-purple-500/20 bg-purple-950/10 px-2 py-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300">Saved MCQs</span>
                      <span className="text-[10px] text-gray-500">{mcqSets.length} set{mcqSets.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {mcqSets.map((set) => (
                        <div
                          key={set.id}
                          className="flex items-center gap-2 rounded-md border border-purple-500/20 bg-[#141018] px-2 py-1.5"
                        >
                          <button
                            onClick={() => setActiveMcqSet({
                              title: set.title,
                              topic: set.topic,
                              notePath: set.notePath,
                              questions: set.questions,
                            })}
                            className="flex-1 min-w-0 text-left text-[11px] text-gray-200 hover:text-purple-200 transition-colors"
                            title="Click to take quiz"
                          >
                            <div className="truncate font-semibold">{set.title}</div>
                            <div className="text-[10px] text-gray-500">{set.questions.length} questions</div>
                          </button>
                          <button
                            onClick={() => deleteMcqSet(set.id)}
                            className="shrink-0 p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Delete this MCQ set"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {brainScope === 'vault' && (
              <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-gray-500">
                <span className="truncate">Vault root: {activeIndexRootName}</span>
                {isVaultSearchLoading ? <Loader2 size={11} className="animate-spin text-cyan-400 shrink-0" /> : null}
              </div>
            )}

            {/* Chat History */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-4 mb-4 pr-1 custom-scrollbar">
              {currentMessages.map((msg, i) => {
                const isMcqStreaming = aiMode === 'mcq' && msg.sender === 'ai' && i === streamingMsgIndex;
                const mcqParsed = msg.sender === 'ai' && brainScope === 'note' && selectedFile ? parseMcqSetFromText(msg.text, selectedFile) : null;
                const isMcqModeMessage = aiMode === 'mcq' && msg.sender === 'ai' && brainScope === 'note' && selectedFile;

                return (
                  <div key={i} className="group/msg relative">
                    {isMcqModeMessage ? (
                      isMcqStreaming ? (
                        <div className="flex items-start">
                          <div className="bg-gradient-to-br from-purple-900/20 to-blue-900/10 text-gray-400 rounded-2xl rounded-tl-sm border border-purple-500/10 px-3 py-2 text-sm">
                            <span className="animate-pulse">Generating MCQs...</span>
                          </div>
                        </div>
                      ) : mcqParsed ? (
                        <div className="flex items-start">
                          <div className="bg-gradient-to-br from-purple-900/20 to-blue-900/10 text-gray-300 rounded-2xl rounded-tl-sm border border-purple-500/10 px-3 py-2 text-sm">
                            <div className="flex items-center gap-2 mb-2">
                              <Check size={14} className="text-purple-400" />
                              <span className="font-semibold text-purple-200">MCQ Ready</span>
                            </div>
                            <div className="text-xs text-gray-400 mb-2">{mcqParsed.questions.length} questions generated for "{mcqParsed.title}"</div>
                            <McqResponseTools text={msg.text} notePath={selectedFile} onSave={saveMcqSet} onOpen={setActiveMcqSet} onDelete={deleteMcqSet} savedSets={mcqSets} />
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start">
                          <div className="bg-gradient-to-br from-purple-900/20 to-blue-900/10 text-gray-400 rounded-2xl rounded-tl-sm border border-purple-500/10 px-3 py-2 text-sm">
                            <span className="animate-pulse">Processing MCQ...</span>
                          </div>
                        </div>
                      )
                    ) : (
                      <>
                        <ChatBubble
                          sender={msg.sender}
                          text={msg.text}
                          context={msg.context}
                          isAction={msg.isAction}
                          options={msg.options?.length
                            ? msg.options
                            : undefined}
                          onOptionSelect={msg.options?.length
                            ? (option) => {
                              handleChatOptionSelect(option, i, msg.questionPrompt, msg.questionId);
                            }
                            : undefined}
                          allowFreeTextReply={msg.sender === 'ai' && !!msg.allowFreeTextReply}
                          freeTextReplyPlaceholder={msg.freeTextReplyPlaceholder}
                          onFreeTextReply={msg.sender === 'ai' && msg.allowFreeTextReply
                            ? (reply) => {
                              handleChatFreeTextReply(reply, i, msg.questionPrompt, msg.questionId);
                            }
                            : undefined}
                          isStreaming={false}
                          onStreamingDone={() => { if (i === streamingMsgIndex) setStreamingMsgIndex(null); }}
                        />
                        {msg.sender === 'user' && !isAiLoading && (
                          <button
                            onClick={() => {
                              setPendingRewindInput(msg.text);
                              setCurrentMessages(prev => prev.slice(0, i));
                            }}
                            className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-amber-400 hover:bg-white/10 transition-all border border-transparent hover:border-white/10 shadow-sm"
                            title="Undo — rewind to this message and edit it"
                          >
                            <Undo2 size={16} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {isAiLoading && currentMessages[currentMessages.length - 1]?.sender !== 'ai' && (
                <div className="flex items-start">
                  <div className="bg-gradient-to-br from-purple-900/20 to-blue-900/10 text-gray-400 rounded-2xl rounded-tl-sm border border-purple-500/10 px-3 py-2 text-sm">
                    <span className="animate-pulse">Thinking...</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Action Confirmation Overlay */}
          {proposedAction && (
            <div className="px-5 pb-4 animate-in slide-in-from-bottom-4 duration-300">
              <div className="bg-purple-900/20 border border-purple-500/30 rounded-lg p-4 shadow-lg backdrop-blur-sm">
                <div className="flex items-center gap-2 mb-2 text-purple-300">
                  <Sparkles size={16} />
                  <span className="text-xs font-bold uppercase tracking-wider">AI Proposal</span>
                </div>
                <p className="text-sm text-gray-200 mb-3">{proposedAction.message || "Confirm this action?"}</p>
                <div className="bg-[#0a0a0a]/80 rounded-md p-2 mb-4 max-h-48 overflow-y-auto border border-[#333] font-mono text-[11px] leading-snug">
                  {proposedAction.scope === 'vault' ? (
                    <>
                      <div className="text-[10px] text-gray-400 mb-2 uppercase tracking-wider font-sans font-bold flex items-center gap-1.5 border-b border-[#333] pb-1.5">
                        Vault Action
                      </div>
                      <div className="space-y-2 text-gray-300">
                        <div>
                          <div className="text-[9px] text-gray-500 font-sans uppercase tracking-wider mb-0.5">Action</div>
                          <pre className="bg-[#111] px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-purple-500/50">{proposedAction.type}</pre>
                        </div>
                        {proposedAction.title && (
                          <div>
                            <div className="text-[9px] text-gray-500 font-sans uppercase tracking-wider mb-0.5">Name</div>
                            <pre className="bg-[#111] px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-blue-500/50">{proposedAction.title}</pre>
                          </div>
                        )}
                        {proposedAction.sourcePath && (
                          <div>
                            <div className="text-[9px] text-gray-500 font-sans uppercase tracking-wider mb-0.5">Source</div>
                            <pre className="bg-[#111] px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-orange-500/50">{proposedAction.sourcePath}</pre>
                          </div>
                        )}
                        {proposedAction.destinationPath && (
                          <div>
                            <div className="text-[9px] text-gray-500 font-sans uppercase tracking-wider mb-0.5">Destination</div>
                            <pre className="bg-[#111] px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-yellow-500/50">{proposedAction.destinationPath}</pre>
                          </div>
                        )}
                        {proposedAction.targetPath && (
                          <div>
                            <div className="text-[9px] text-gray-500 font-sans uppercase tracking-wider mb-0.5">Target</div>
                            <pre className="bg-[#111] px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-cyan-500/50">{proposedAction.targetPath}</pre>
                          </div>
                        )}
                        {proposedAction.type === 'edit_note' ? (
                          <>
                            {proposedAction.target_text && (
                              <div>
                                <div className="text-[9px] text-red-400 font-sans uppercase tracking-wider mb-0.5">To Remove</div>
                                <pre className="bg-red-500/10 text-red-300 px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-red-500/50">
                                  {proposedAction.target_text}
                                </pre>
                              </div>
                            )}
                            <div>
                              <div className="text-[9px] text-green-400 font-sans uppercase tracking-wider mb-0.5">To Insert</div>
                              <pre className="bg-green-500/10 text-green-300 px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-green-500/50">
                                {(proposedAction.content && proposedAction.content.trim()) || '[No insertion content parsed. Retry request.]'}
                              </pre>
                            </div>
                          </>
                        ) : proposedAction.content ? (
                          <div>
                            <div className="text-[9px] text-green-400 font-sans uppercase tracking-wider mb-0.5">Markdown Content</div>
                            <pre className="bg-green-500/10 text-green-300 px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-green-500/50">
                              {proposedAction.content.trim()}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-[10px] text-gray-400 mb-2 uppercase tracking-wider font-sans font-bold flex items-center gap-1.5 border-b border-[#333] pb-1.5">
                        {proposedAction.type === 'replace_selection' || proposedAction.type === 'find_and_replace' || proposedAction.type === 'replace_all' ? 'Proposed Change (Diff View)' : 'Proposed Addition'}
                      </div>

                      {proposedAction.target_text && (
                        <div className="mb-1.5 group">
                          <div className="text-[9px] text-red-400 font-sans uppercase tracking-wider mb-0.5 select-none opacity-80 group-hover:opacity-100 transition-opacity">To Remove</div>
                          <pre className="bg-red-500/10 text-red-300 px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-red-500/50">
                            {proposedAction.target_text}
                          </pre>
                        </div>
                      )}

                      <div className="group mt-2">
                        <div className="text-[9px] text-green-400 font-sans uppercase tracking-wider mb-0.5 select-none opacity-80 group-hover:opacity-100 transition-opacity">To Insert</div>
                        <pre className="bg-green-500/10 text-green-300 px-2 py-1.5 rounded whitespace-pre-wrap border-l-2 border-green-500/50">
                          {(proposedAction.content && proposedAction.content.trim()) || '[No insertion content parsed. Retry request.]'}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleApplyAction}
                    className="flex-1 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-2 rounded transition-colors shadow-md"
                  >
                    Confirm & Apply
                  </button>
                  <button
                    onClick={() => setProposedAction(null)}
                    className="px-3 bg-[#262626] hover:bg-[#333] text-gray-300 text-xs font-bold py-2 rounded transition-colors"
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Context Chip */}
          {brainScope === 'note' && selectedContext && (
            <div className="mx-4 mt-2 p-2 bg-[#262626] border border-purple-500/30 rounded-lg flex items-start gap-2 animate-in slide-in-from-bottom-2 fade-in duration-200">
              <div className="mt-0.5 text-purple-400">
                <Sparkles size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-purple-400 font-bold uppercase tracking-wider mb-0.5">Using Context</div>
                <div className="text-xs text-gray-300 line-clamp-2 font-mono border-l-2 border-purple-500/50 pl-2">
                  {selectedContext}
                </div>
              </div>
              <button
                onClick={() => { setSelectedContext(''); window.getSelection()?.removeAllRanges(); }}
                className="p-1 hover:bg-white/10 rounded text-gray-500 hover:text-white transition-colors"
              >
                <PanelLeftClose size={14} className="rotate-45" /> {/* Using as X icon */}
              </button>
            </div>
          )}

          {/* Input Area */}
          <ChatInputBox
            onSend={handleAiSend}
            onStop={handleStopAi}
            isLoading={isAiLoading}
            showModeToggle={brainScope === 'note'}
            mode={aiMode}
            onModeChange={(nextMode) => {
              setAiMode(nextMode);
              setProposedAction(null);
            }}
            placeholder={brainScope === 'vault'
              ? 'Ask about your markdown vault, or ask Brain to organize notes...'
              : `Ask Atheletia about ${selectedFile ? 'this note' : 'your notes'}...`}
            pendingInput={pendingRewindInput}
            onPendingInputConsumed={() => setPendingRewindInput(null)}
          />
        </div>
      )}

      {activeMcqSet && (
        <McqPopup
          mcqSet={{
            id: activeMcqSet.notePath,
            notePath: activeMcqSet.notePath,
            title: activeMcqSet.title,
            topic: activeMcqSet.topic,
            questions: activeMcqSet.questions,
            createdAt: Date.now(),
          }}
          onClose={() => setActiveMcqSet(null)}
        />
      )}
    </div>
  );
};
