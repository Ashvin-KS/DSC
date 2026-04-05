import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  Cloud,
  Cpu,
  Loader2,
  Check,
  Minus,
  Plus
} from 'lucide-react';
import { BrainActionType, BrainChatMessage, BrainChatOption, ParsedActionPayload, buildBrainNoteContext, buildModelConversation, inferActionContentFromResponse, isUiTranscriptNoise, parseActionPayload, sanitizeProposedMarkdown } from '../services/brainAiService';
import { MermaidBlock } from '../components/MermaidBlock';
import { buildFileTreeSignature, cacheFileContent, cacheFileTree, getCachedFileContent, getCachedFileTree, invalidateFileTreeCache } from '../lib/notesCache';

const DEFAULT_VAULT = '';
const BRAIN_LAST_MODEL_STORAGE_KEY = 'brain_last_selected_model';
const DEFAULT_NIM_MODEL = 'meta/llama-3.3-70b-instruct';
const DEFAULT_BRAIN_SCOPE: BrainScope = 'note';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

type BrainScope = 'note' | 'vault';

interface VaultSearchHit {
  path: string;
  summary: string;
  snippet: string;
  score: number;
}

interface VaultSearchResult {
  indexedFiles: number;
  indexedChunks: number;
  route: string;
  promptContext: string;
  hits: VaultSearchHit[];
}

interface VaultIndexProgress {
  vault_path: string;
  stage: string;
  total_files: number;
  processed_files: number;
  indexed_chunks: number;
  current_file?: string | null;
}

type VaultResolveConfidence = 'high' | 'medium' | 'low';

interface VaultPathResolution {
  requestedPath: string;
  resolvedPath: string | null;
  candidates: string[];
  confidence: VaultResolveConfidence;
  reason: string;
}

const dedupeEquivalentPaths = (input: string[]): string[] => {
  const deduped: string[] = [];
  for (const value of input) {
    if (!value) continue;
    const cleaned = value.trim();
    if (!cleaned) continue;
    if (deduped.some(existing => areEquivalentPaths(existing, cleaned))) continue;
    deduped.push(cleaned);
  }
  return deduped;
};

const extractMarkdownHeadingTitles = (markdown: string): string[] => {
  const matches = markdown.match(/^#{1,6}\s+.+$/gm) || [];
  const titles = matches
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(titles));
};

const normalizeMarkdownFileName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
};

const findNodeByPath = (nodes: FileNode[], targetPath: string | null): FileNode | null => {
  if (!targetPath) return null;
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children?.length) {
      const nested = findNodeByPath(node.children, targetPath);
      if (nested) return nested;
    }
  }
  return null;
};

const getParentDirectory = (inputPath: string): string | null => {
  const parts = inputPath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return null;
  const separator = inputPath.includes('\\') ? '\\' : '/';
  const prefix = inputPath.startsWith('\\') ? '\\' : '';
  return `${prefix}${parts.slice(0, -1).join(separator)}`;
};

const getDirectoryForNodePath = (targetPath: string | null, nodes: FileNode[], vaultRoot: string): string => {
  const node = findNodeByPath(nodes, targetPath);
  if (!node) return vaultRoot;
  if (node.isDirectory) return node.path;
  return getParentDirectory(node.path) || vaultRoot;
};

const normalizePathForComparison = (value: string | null | undefined): string => {
  if (!value) return '';
  return value
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
};

const areEquivalentPaths = (left: string | null | undefined, right: string | null | undefined): boolean => {
  const normalizedLeft = normalizePathForComparison(left);
  const normalizedRight = normalizePathForComparison(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
};

const pathIsWithin = (candidate: string | null | undefined, root: string | null | undefined): boolean => {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedRoot = normalizePathForComparison(root);
  if (!normalizedCandidate || !normalizedRoot) return false;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
};

const stripWindowsExtendedPathPrefix = (inputPath: string): string => {
  return inputPath.replace(/^\\\\\?\\/, '');
};

const isAbsoluteFilePath = (inputPath: string): boolean => {
  const cleaned = stripWindowsExtendedPathPrefix(inputPath);
  return /^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith('\\\\');
};

const joinFileSystemPath = (basePath: string, childPath: string): string => {
  const base = stripWindowsExtendedPathPrefix(basePath).replace(/[\\/]+$/, '');
  const child = stripWindowsExtendedPathPrefix(childPath).replace(/^[/\\]+/, '');
  const separator = base.includes('\\') ? '\\' : '/';
  return `${base}${separator}${child.replace(/[\\/]+/g, separator)}`;
};

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const collectDirectoryPaths = (nodes: FileNode[], max = 40): string[] => {
  const discovered: string[] = [];
  const queue: FileNode[] = [...nodes];

  while (queue.length > 0 && discovered.length < max) {
    const node = queue.shift();
    if (!node) break;
    if (node.isDirectory) {
      discovered.push(node.path);
      if (node.children?.length) {
        queue.push(...node.children);
      }
    }
  }

  return discovered;
};

const collectMarkdownPaths = (nodes: FileNode[], max = 200): string[] => {
  const discovered: string[] = [];
  const queue: FileNode[] = [...nodes];

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
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return 'Unknown connection error.';
};

const sanitizeVisibleBrainResponse = (text: string): string => {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/ig, '').trim();

  cleaned = cleaned
    .replace(/<nexus_action_json>[\s\S]*$/ig, '')
    .replace(/<nexus_content>[\s\S]*$/ig, '')
    .replace(/```json[\s\S]*$/ig, '')
    .replace(/<\/?nexus_action_json>/ig, '')
    .replace(/<\/?nexus_content>/ig, '')
    .trim();

  if (/^(The user asks:|User asks:)/i.test(cleaned) || /According to instructions/i.test(cleaned)) {
    const anchorCandidates = ["I'm ", 'I dont ', "I don't ", 'I found ', 'No matching', 'No note', 'I can'];
    const anchorIndexes = anchorCandidates
      .map(anchor => cleaned.indexOf(anchor))
      .filter((index) => index >= 0);

    if (anchorIndexes.length > 0) {
      cleaned = cleaned.slice(Math.min(...anchorIndexes)).trim();
    }

    cleaned = cleaned
      .split('\n')
      .filter(line => !/^(The user asks:|User asks:|The user just said|No specific request\.?|They want to|In the vault evidence,|According to instructions,?|No evidence shows that\.?|So we cannot locate\.?)/i.test(line.trim()))
      .join('\n')
      .trim();
  }

  if (!cleaned) {
    const greeting = text.match(/(Hi!.*|Hello!.*|Hey!.*)$/is);
    if (greeting?.[1]) {
      return greeting[1].trim();
    }
  }

  return cleaned;
};

const isMarkdownPath = (targetPath: string): boolean => targetPath.toLowerCase().endsWith('.md');

const filterMarkdownTree = (nodes: FileNode[]): FileNode[] =>
  nodes
    .map(node => {
      if (!node.isDirectory) {
        return isMarkdownPath(node.path) ? node : null;
      }

      const children = filterMarkdownTree(node.children || []);
      if (children.length === 0) return null;
      return { ...node, children };
    })
    .filter((node): node is FileNode => Boolean(node));

const normalizeClarificationOptions = (rawOptions: unknown, questionId: string): BrainChatOption[] => {
  if (!Array.isArray(rawOptions)) return [];

  const normalized: BrainChatOption[] = [];
  for (let index = 0; index < rawOptions.length; index += 1) {
    const option = rawOptions[index];
    if (typeof option === 'string') {
      const trimmed = option.trim();
      if (!trimmed) continue;
      normalized.push({
        id: `${questionId}:option:${index}`,
        action: 'answer_question',
        value: trimmed,
        label: trimmed,
        questionId,
      });
      continue;
    }

    if (!option || typeof option !== 'object') continue;
    const candidate = option as { label?: unknown; value?: unknown; description?: unknown };
    const label = typeof candidate.label === 'string'
      ? candidate.label.trim()
      : typeof candidate.value === 'string'
        ? candidate.value.trim()
        : '';
    const value = typeof candidate.value === 'string'
      ? candidate.value.trim()
      : label;
    if (!label || !value) continue;

    normalized.push({
      id: `${questionId}:option:${index}`,
      action: 'answer_question',
      value,
      label,
      description: typeof candidate.description === 'string' ? candidate.description.trim() : undefined,
      questionId,
    });
  }

  return normalized.slice(0, 8);
};

const isExplicitWholeRewriteIntent = (input: string): boolean => {
  const normalized = input.toLowerCase();
  return /\b(rewrite|re-write|replace\s+(the\s+)?whole|replace\s+(the\s+)?entire|rewrite\s+(the\s+)?whole|rewrite\s+(the\s+)?entire|full\s+rewrite|reformat\s+(the\s+)?whole|overhaul\s+(the\s+)?note)\b/i.test(normalized);
};

const hasOperationIntent = (input: string): boolean =>
  /\b(edit|update|rewrite|modify|add|create|move|rename|delete|open|organize|fix|improve|change)\b/i.test(input);

const hasSpecificEditTarget = (input: string): boolean =>
  /\.md\b|line\s+\d+|section\b|heading\b|paragraph\b|replace\b|append\b|insert\b|target\b|under\b|in\s+.+/i.test(input);

const isAmbiguousOperationRequest = (input: string): boolean => {
  if (!hasOperationIntent(input)) return false;
  if (isExplicitWholeRewriteIntent(input)) return false;
  const compact = input.trim();
  if (compact.length <= 40) return true;
  return !hasSpecificEditTarget(compact);
};

const looksLikeClarificationQuestion = (input: string): boolean =>
  /\?|what\s+should|which\s+file|what\s+specific|how\s+should\s+i|what\s+changes|what\s+to\s+add|what\s+to\s+edit/i.test(input);

const isVaultPathActionIntent = (input: string): boolean =>
  /\b(create|open|move|rename|delete|folder|note|file|path|inside|under|into|destination)\b|\.md\b/i.test(input);

const isBulkVaultOpenIntent = (input: string): boolean =>
  /\bopen\b.*\b(all|every)\b.*\b(files|notes|docs|documents)\b|\b(all|every)\b.*\b(files|notes|docs|documents)\b.*\bopen\b/i.test(input);

const buildBrainActionPreview = (actionData: ParsedActionPayload): string => {
  const explanation = actionData.explanation?.trim();
  if (explanation) return explanation;

  const readableTarget =
    actionData.target_path?.trim()
    || actionData.destination_path?.trim()
    || actionData.source_path?.trim()
    || actionData.title?.trim()
    || 'the requested item';

  switch (actionData.action) {
    case 'create_note':
      return `Ready to create ${actionData.title?.trim() || 'a new note'}.`;
    case 'edit_note':
      return `Ready to edit ${readableTarget}.`;
    case 'create_folder':
      return `Ready to create folder ${actionData.title?.trim() || readableTarget}.`;
    case 'move_note':
      return `Ready to move ${actionData.source_path?.trim() || 'the selected note'}.`;
    case 'open_note':
      return `Ready to open ${readableTarget}.`;
    case 'rename_note':
      return `Ready to rename ${readableTarget}.`;
    case 'delete_item':
      return `Ready to delete ${readableTarget}.`;
    case 'replace_selection':
      return 'Ready to replace the selected text.';
    case 'insert_at_cursor':
    case 'insert_content':
      return 'Ready to insert the generated content.';
    case 'find_and_replace':
      return 'Ready to update the matched text in the current note.';
    case 'replace_all':
      return 'Ready to rewrite the current note.';
    case 'ask_question':
      return actionData.question?.trim() || 'I need one clarification before continuing.';
    default:
      return 'Ready to continue with the requested action.';
  }
};

// Unified Styles Configuration
const MARKDOWN_STYLES = {
  h1: "text-3xl font-bold text-white mt-6 mb-3",
  h2: "text-2xl font-bold text-white mt-6 mb-3",
  h3: "text-xl font-semibold text-white mt-4 mb-2",
  h4: "text-lg font-semibold text-white mt-4 mb-2",
  h5: "text-base font-semibold text-white mt-3 mb-1",
  h6: "text-sm font-semibold text-gray-300 mt-3 mb-1",
  p: "text-gray-300 my-2 leading-relaxed",
  ul: "list-disc list-inside text-gray-300 my-2 space-y-1 ml-1",
  ol: "list-decimal list-inside text-gray-300 my-2 space-y-1 ml-1",
  li: "text-gray-300 pl-1",
  codeInline: "bg-[#262626] px-1.5 py-0.5 rounded text-purple-300 text-sm font-mono",
  codeBlock: "bg-[#1a1a1a] p-4 rounded-lg overflow-x-auto text-sm my-3 border border-[#333] text-gray-300 font-mono",
  a: "text-blue-400 hover:underline cursor-pointer",
  blockquote: "border-l-4 border-purple-500 pl-4 text-gray-400 my-3 italic",
  hr: "border-[#333] my-4",
  img: "max-w-full rounded-lg my-3",
  table: "w-full border-collapse text-sm my-3",
  th: "text-left px-3 py-2 text-gray-200 font-semibold border-b border-[#333]",
  td: "px-3 py-2 text-gray-300 border-b border-[#262626]",
  tr: "hover:bg-[#1a1a1a]"
};

const looksLikeMermaid = (input: string): boolean => {
  const t = input.trimStart();
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|architecture|block-beta)\b/m.test(t);
};

// Tiptap Editor Component
const TiptapEditor: React.FC<{
  content: string;
  onChange: (content: string) => void;
  onEditorCreate?: (editor: any) => void;
  onSelectionChange?: (text: string) => void;
  onSelectionRangeChange?: (range: { from: number; to: number } | null) => void;
}> = ({ content, onChange, onEditorCreate, onSelectionChange, onSelectionRangeChange }) => {
  const [isFocused, setIsFocused] = useState(false);

  const editor = useEditor({
    onCreate: ({ editor }) => {
      onEditorCreate?.(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to, empty } = editor.state.selection;
      if (!empty) {
        const text = editor.state.doc.textBetween(from, to, '\n');
        onSelectionChange?.(text);
        onSelectionRangeChange?.({ from, to });
      } else {
        onSelectionRangeChange?.({ from, to: from }); // Cursor position
      }
    },
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
          HTMLAttributes: {
            class: (node) => MARKDOWN_STYLES[`h${node.level}` as keyof typeof MARKDOWN_STYLES] || '',
          }
        },
        paragraph: {
          HTMLAttributes: { class: MARKDOWN_STYLES.p },
        },
        bulletList: {
          HTMLAttributes: { class: MARKDOWN_STYLES.ul },
        },
        orderedList: {
          HTMLAttributes: { class: MARKDOWN_STYLES.ol },
        },
        listItem: {
          HTMLAttributes: { class: MARKDOWN_STYLES.li },
        },
        codeBlock: {
          HTMLAttributes: { class: MARKDOWN_STYLES.codeBlock },
        },
        blockquote: {
          HTMLAttributes: { class: MARKDOWN_STYLES.blockquote },
        },
        horizontalRule: {
          HTMLAttributes: { class: MARKDOWN_STYLES.hr },
        },
        bold: {
          HTMLAttributes: { class: "font-bold text-white" },
        },
        italic: {
          HTMLAttributes: { class: "italic text-gray-400" },
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: MARKDOWN_STYLES.a },
      }),
      Image.configure({
        HTMLAttributes: { class: MARKDOWN_STYLES.img },
      }),
      TaskList.configure({
        HTMLAttributes: {
          class: 'task-list pl-0 list-none',
        },
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: {
          class: 'task-item flex items-start gap-2',
        },
      }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: content,
    editorProps: {
      attributes: {
        class: 'prose prose-invert max-w-none focus:outline-none min-h-[calc(100vh-200px)] py-4 px-8',
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = (editor.storage as any)?.markdown?.getMarkdown();
      if (markdown !== undefined) {
        onChange(markdown);
      }
    },
    onFocus: () => setIsFocused(true),
    onBlur: () => setIsFocused(false),
  });

  // Update content if it changes externally
  useEffect(() => {
    if (!editor) return;

    const currentMarkdown = (editor.storage as any)?.markdown?.getMarkdown();
    if (currentMarkdown !== undefined) {
      const normalize = (str: string) => str.replace(/\r\n/g, '\n').trim();
      if (normalize(content) !== normalize(currentMarkdown)) {
        // We update even if focused to ensure AI edits show up
        // setContent(content, false) helps prevent some jumpiness
        (editor.commands as any).setContent(content, false);
      }
    }
  }, [content, editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full w-full">

      {/* Main Toolbar - Always Visible */}
      <div className={`flex items-center gap-1 px-4 py-2 border-b border-[#262626] bg-[#0a0a0a]/80 backdrop-blur sticky top-0 z-10 transition-opacity ${isFocused ? 'opacity-100' : 'opacity-50 hover:opacity-100'}`}>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('heading', { level: 1 }) ? 'text-purple-400' : 'text-gray-500'}`} title="Heading 1">
          <Heading1 size={16} />
        </button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('heading', { level: 2 }) ? 'text-purple-400' : 'text-gray-500'}`} title="Heading 2">
          <Heading2 size={16} />
        </button>
        <div className="w-px h-4 bg-[#262626] mx-1" />
        <button onClick={() => editor.chain().focus().toggleBold().run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('bold') ? 'text-purple-400' : 'text-gray-500'}`} title="Bold">
          <Bold size={16} />
        </button>
        <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('italic') ? 'text-purple-400' : 'text-gray-500'}`} title="Italic">
          <Italic size={16} />
        </button>
        <div className="w-px h-4 bg-[#262626] mx-1" />
        <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('bulletList') ? 'text-purple-400' : 'text-gray-500'}`} title="Bullet List">
          <List size={16} />
        </button>
        <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('orderedList') ? 'text-purple-400' : 'text-gray-500'}`} title="Numbered List">
          <ListOrdered size={16} />
        </button>
        <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('taskList') ? 'text-purple-400' : 'text-gray-500'}`} title="Task List">
          <CheckSquare size={16} />
        </button>
        <div className="w-px h-4 bg-[#262626] mx-1" />
        <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`p-1.5 rounded hover:bg-[#262626] ${editor.isActive('blockquote') ? 'text-purple-400' : 'text-gray-500'}`} title="Blockquote">
          <Quote size={16} />
        </button>
      </div>

      <EditorContent editor={editor} className="flex-1 w-full" />
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
  const vaultChatRef = useRef(`brain_vault_chat_${localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT}`);
  const [vaultSearchMeta, setVaultSearchMeta] = useState<VaultSearchResult | null>(null);
  const [isVaultSearchLoading, setIsVaultSearchLoading] = useState(false);
  const [isVaultReindexing, setIsVaultReindexing] = useState(false);
  const [activeVaultIndexRoot, setActiveVaultIndexRoot] = useState<string | null>(() => {
    return localStorage.getItem('brain_vaultPath') || DEFAULT_VAULT;
  });
  const [vaultIndexProgress, setVaultIndexProgress] = useState<VaultIndexProgress | null>(null);
  const [, setVaultStatusMessage] = useState('Vault mode can search the whole markdown vault and prepare note or folder actions from the index root.');
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || DEFAULT_NIM_MODEL);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [availableModels, setAvailableModels] = useState<{ id: string, name?: string }[]>([]);
  const [aiProvider, setAiProvider] = useState<'nvidia' | 'local' | 'lmstudio'>('nvidia');
  const [nvidiaApiKey, setNvidiaApiKey] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);

  // Cloud/Local model lists
  const [lmStudioModels, setLmStudioModels] = useState<{ id: string, name?: string }[]>([]);
  const [cloudModels, setCloudModels] = useState<{ id: string, name?: string }[]>([]);
  const [lmStudioLoading, setLmStudioLoading] = useState(false);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [lmStudioError, setLmStudioError] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [streamingMsgIndex, setStreamingMsgIndex] = useState<number | null>(null);
  const [aiMode, setAiMode] = useState<'lecture' | 'edit'>('lecture');
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
  }, [vaultPath]);

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
          console.log(`[Nexus View] Selected Lines: ${startLine}-${endLine}`);
        } else {
          console.warn('[Nexus View] Could not find selected text in raw content');
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
      const modelsRaw = await window.nexusAPI?.settings?.getLMStudioModels?.();
      const normalized = (Array.isArray(modelsRaw) ? modelsRaw : [])
        .map((m: any) => ({ id: m?.id || String(m), name: m?.name || m?.id || String(m) }))
        .filter((m: { id: string }) => !!m.id);
      setLmStudioModels(normalized);
      setAvailableModels(normalized);
      if (normalized.length > 0) {
        const lastModel = localStorage.getItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_local`) || localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || '';
        const hasLast = normalized.some((m: any) => m.id === lastModel);
        if (hasLast) {
          setSelectedModel(lastModel);
        } else {
          setSelectedModel(normalized[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch LM Studio models:', err);
      setLmStudioError('LM Studio not reachable. Make sure it is running.');
      setLmStudioModels([]);
      setAvailableModels([]);
    } finally {
      setLmStudioLoading(false);
      setModelsLoading(false);
    }
  }, []);

  // Fetch NVIDIA cloud models
  const fetchCloudModels = useCallback(async () => {
    setCloudLoading(true);
    try {
      const settings = await window.nexusAPI?.settings?.get?.();
      const key = settings?.nvidiaApiKey || '';
      setNvidiaApiKey(key);

      if (!key) {
        setCloudModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
        setAvailableModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
        return;
      }

      const modelsRaw = window.nexusAPI?.settings?.getNvidiaModels
        ? await window.nexusAPI.settings.getNvidiaModels(key)
        : await (async () => {
          const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` }
          });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error (${response.status}): ${errorText.slice(0, 100)}`);
          }
          return response.json();
        })();

      const normalized = (Array.isArray(modelsRaw) ? modelsRaw : (modelsRaw?.data || []))
        .map((m: any) => ({ id: m?.id || String(m), name: m?.name || m?.id || String(m) }))
        .filter((m: { id: string }) => !!m.id);

      if (normalized.length > 0) {
        setCloudModels(normalized);
        setAvailableModels(normalized);
        const lastModel = localStorage.getItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_cloud`) || localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || '';
        const hasLast = normalized.some((m: any) => m.id === lastModel);
        if (hasLast) {
          setSelectedModel(lastModel);
        } else {
          setSelectedModel(normalized[0].id);
        }
      } else {
        setCloudModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
        setAvailableModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
      }
    } catch (error) {
      console.error('Failed to fetch cloud models:', error);
      setCloudModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
      setAvailableModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
    } finally {
      setCloudLoading(false);
      setModelsLoading(false);
    }
  }, []);

  // Detect initial provider and fetch models on mount
  useEffect(() => {
    const init = async () => {
      try {
        const settings = await window.nexusAPI?.settings?.get?.();
        const provider = ((settings?.aiProvider || 'nvidia').toLowerCase() as 'nvidia' | 'local' | 'lmstudio');
        const localProvider = provider === 'local' || provider === 'lmstudio';
        setAiProvider(localProvider ? 'lmstudio' : 'nvidia');
        setNvidiaApiKey(settings?.nvidiaApiKey || '');
        const lastModel = localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || settings?.defaultModel || DEFAULT_NIM_MODEL;
        setSelectedModel(lastModel);
        if (localProvider) {
          fetchLMStudioModels();
        } else {
          fetchCloudModels();
        }
      } catch (error) {
        console.error('Failed to init models:', error);
        setAvailableModels([{ id: DEFAULT_NIM_MODEL, name: DEFAULT_NIM_MODEL }]);
        setSelectedModel(localStorage.getItem(BRAIN_LAST_MODEL_STORAGE_KEY) || DEFAULT_NIM_MODEL);
        setModelsLoading(false);
      }
    };
    init();
  }, [fetchLMStudioModels, fetchCloudModels]);

  // Switch provider at runtime
  const switchProvider = useCallback((mode: 'nvidia' | 'lmstudio') => {
    setAiProvider(mode);
    setModelsLoading(true);
    if (mode === 'lmstudio') {
      if (lmStudioModels.length > 0) {
        setAvailableModels(lmStudioModels);
        const lastLocal = localStorage.getItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_local`) || lmStudioModels[0]?.id || '';
        const hasLocal = lmStudioModels.some(m => m.id === lastLocal);
        setSelectedModel(hasLocal ? lastLocal : (lmStudioModels[0]?.id || ''));
        setModelsLoading(false);
      } else {
        fetchLMStudioModels();
      }
    } else {
      if (cloudModels.length > 0) {
        setAvailableModels(cloudModels);
        const lastCloud = localStorage.getItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_cloud`) || cloudModels[0]?.id || '';
        const hasCloud = cloudModels.some(m => m.id === lastCloud);
        setSelectedModel(hasCloud ? lastCloud : (cloudModels[0]?.id || ''));
        setModelsLoading(false);
      } else {
        fetchCloudModels();
      }
    }
  }, [lmStudioModels, cloudModels, fetchLMStudioModels, fetchCloudModels]);

  useEffect(() => {
    if (!selectedModel?.trim()) return;
    if (aiProvider === 'lmstudio' || aiProvider === 'local') {
      localStorage.setItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_local`, selectedModel);
    } else {
      localStorage.setItem(`${BRAIN_LAST_MODEL_STORAGE_KEY}_cloud`, selectedModel);
    }
    localStorage.setItem(BRAIN_LAST_MODEL_STORAGE_KEY, selectedModel); // Legacy fallback
  }, [selectedModel, aiProvider]);

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
  const showVaultIndexDoneMark = brainScope === 'vault' && !isVaultReindexing && vaultIndexProgress?.stage === 'completed';
  const showVaultProgressInHeader = isVaultReindexing || vaultIndexProgress?.stage === 'indexing' || vaultIndexProgress?.stage === 'started';

  const stopVaultReindex = useCallback(async (statusMessage = 'Stopped vault indexing.') => {
    if (!window.nexusAPI?.notes?.cancelVaultReindex) {
      return;
    }

    try {
      await window.nexusAPI.notes.cancelVaultReindex();
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
    }
  }, []);

  const reindexOpenedVault = useCallback(async (startMessage?: string) => {
    if (!window.nexusAPI?.notes) return null;

    // Always index from the currently opened vault root, never from a nested folder.
    const openedVaultRoot = vaultPath;
    setActiveVaultIndexRoot(openedVaultRoot);
    setIsVaultReindexing(true);
    if (startMessage) {
      setVaultStatusMessage(startMessage);
    }

    try {
      const result = await window.nexusAPI.notes.reindexVault(openedVaultRoot);
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
    }
  }, [isVaultReindexing, reindexOpenedVault, stopVaultReindex]);

  const loadFileTree = useCallback(async (force = false) => {
    if (!vaultPath || !window.nexusAPI?.notes) return;
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
    const tree = filterMarkdownTree(await window.nexusAPI.notes.getFileTree(vaultPath));
    const entry = cacheFileTree(vaultPath, tree);
    // Only update React state if the tree actually changed
    setFileTree(prev => {
      const prevSignature = buildFileTreeSignature(prev);
      if (prevSignature === entry.signature) return prev;
      return tree;
    });
  }, [vaultPath]);

  const syncVaultSubtreeInBackground = useCallback((subtreePath?: string | null, refreshTree = false) => {
    if (!subtreePath || !window.nexusAPI?.notes?.reindexSubtree) {
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

    void window.nexusAPI.notes
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
    if (!window.nexusAPI?.notes) {
      alert('Notes API not available. Make sure you are running in the Tauri desktop app.');
      return;
    }
    const path = await window.nexusAPI.notes.selectVault();
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
    if (!window.nexusAPI?.notes) return false;
    const content = !force
      ? getCachedFileContent(filePath) ?? await window.nexusAPI.notes.readFile(filePath)
      : await window.nexusAPI.notes.readFile(filePath);
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
    if (!window.nexusAPI?.notes) return null;

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
      const content = await window.nexusAPI.notes.readFile(candidate);
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

  const resolveVaultFilePathWithConfidence = useCallback(async (
    rawTargetPath: string,
    destinationPath?: string | null,
    maxCandidates = 6,
  ): Promise<VaultPathResolution> => {
    const requestedPath = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!requestedPath) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'Missing target path.',
      };
    }

    const primary = await resolveVaultTargetPath(requestedPath, destinationPath);
    const choiceCandidates = resolveVaultOpenChoicePaths(requestedPath, destinationPath, Math.max(maxCandidates, 12));
    const fallbackCandidates = suggestVaultNotePaths(requestedPath, maxCandidates)
      .map(path => (isAbsoluteFilePath(path) ? path : joinFileSystemPath(vaultActionRoot, path)));

    const candidates = dedupeEquivalentPaths([
      ...(primary ? [primary] : []),
      ...choiceCandidates,
      ...fallbackCandidates,
    ]).slice(0, maxCandidates);

    if (!candidates.length) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'No matching note candidates were found.',
      };
    }

    const requestedNormalized = requestedPath
      .replace(/^[.][\\/]+/, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .toLowerCase();
    const topRelative = toVaultRelativePath(candidates[0])
      .replace(/[\\/]+/g, '/')
      .replace(/\.md$/i, '')
      .toLowerCase();
    const hasPrimary = !!primary && candidates.some(path => areEquivalentPaths(path, primary));

    let confidence: VaultResolveConfidence = 'low';
    if (candidates.length === 1 && hasPrimary) {
      confidence = 'high';
    } else if (candidates.length === 1) {
      confidence = topRelative === requestedNormalized ? 'high' : 'medium';
    } else if (hasPrimary) {
      confidence = 'medium';
    }

    return {
      requestedPath,
      resolvedPath: confidence === 'low' ? null : (primary || candidates[0]),
      candidates,
      confidence,
      reason: confidence === 'high'
        ? 'Resolved to a single high-confidence note path.'
        : confidence === 'medium'
          ? 'Resolved, but multiple note candidates are possible.'
          : 'Multiple note candidates are ambiguous.',
    };
  }, [resolveVaultOpenChoicePaths, resolveVaultTargetPath, suggestVaultNotePaths, toVaultRelativePath, vaultActionRoot]);

  const resolveVaultNodePathWithConfidence = useCallback((
    rawTargetPath: string,
    destinationPath?: string | null,
    maxCandidates = 6,
  ): VaultPathResolution => {
    const requestedPath = stripWindowsExtendedPathPrefix(rawTargetPath || '').trim();
    if (!requestedPath) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'Missing target path.',
      };
    }

    const primary = resolveVaultExistingNodePath(requestedPath, destinationPath);
    const noteCandidates = suggestVaultNotePaths(requestedPath, maxCandidates)
      .map(path => (isAbsoluteFilePath(path) ? path : joinFileSystemPath(vaultActionRoot, path)));
    const directoryCandidates = suggestVaultDirectoryPaths(requestedPath, maxCandidates);

    const candidates = dedupeEquivalentPaths([
      ...(primary ? [primary] : []),
      ...noteCandidates,
      ...directoryCandidates,
    ]).slice(0, maxCandidates);

    if (!candidates.length) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'No matching file or folder candidates were found.',
      };
    }

    const hasPrimary = !!primary && candidates.some(path => areEquivalentPaths(path, primary));
    let confidence: VaultResolveConfidence = 'low';
    if (hasPrimary && candidates.length === 1) {
      confidence = 'high';
    } else if (hasPrimary || candidates.length === 1) {
      confidence = 'medium';
    }

    return {
      requestedPath,
      resolvedPath: confidence === 'low' ? null : (primary || candidates[0]),
      candidates,
      confidence,
      reason: confidence === 'high'
        ? 'Resolved to a single high-confidence file/folder path.'
        : confidence === 'medium'
          ? 'Resolved, but multiple file/folder candidates are possible.'
          : 'Multiple file/folder candidates are ambiguous.',
    };
  }, [resolveVaultExistingNodePath, suggestVaultDirectoryPaths, suggestVaultNotePaths, vaultActionRoot]);

  const resolveVaultDestinationWithConfidence = useCallback((
    rawDestinationPath?: string | null,
    maxCandidates = 6,
  ): VaultPathResolution => {
    const requestedPath = stripWindowsExtendedPathPrefix(rawDestinationPath || '').trim();
    const resolvedDestination = resolveVaultDestinationDirectory(rawDestinationPath);

    if (!requestedPath) {
      return {
        requestedPath,
        resolvedPath: resolvedDestination,
        candidates: [resolvedDestination],
        confidence: 'low',
        reason: 'No destination path provided; defaulting to the selected folder, current note folder, or vault root.',
      };
    }

    const directNode = findNodeByPath(fileTree, resolvedDestination);
    const directoryCandidates = suggestVaultDirectoryPaths(requestedPath, maxCandidates);
    const candidates = dedupeEquivalentPaths([
      ...(directNode?.isDirectory ? [resolvedDestination] : []),
      ...directoryCandidates,
    ]).slice(0, maxCandidates);

    if (!candidates.length) {
      return {
        requestedPath,
        resolvedPath: null,
        candidates: [],
        confidence: 'low',
        reason: 'No matching destination folders were found.',
      };
    }

    let confidence: VaultResolveConfidence = 'low';
    if (directNode?.isDirectory && candidates.length === 1) {
      confidence = 'high';
    } else if (directNode?.isDirectory || candidates.length === 1) {
      confidence = 'medium';
    }

    return {
      requestedPath,
      resolvedPath: confidence === 'low' ? null : (directNode?.isDirectory ? resolvedDestination : candidates[0]),
      candidates,
      confidence,
      reason: confidence === 'high'
        ? 'Resolved to a single high-confidence destination folder.'
        : confidence === 'medium'
          ? 'Resolved destination, but alternative folders are possible.'
          : 'Destination folder candidates are ambiguous.',
    };
  }, [fileTree, resolveVaultDestinationDirectory, suggestVaultDirectoryPaths]);

  const pushVaultClarificationQuestion = useCallback((
    questionPrompt: string,
    questionOptions: BrainChatOption[],
    placeholder = 'Type your answer',
  ) => {
    const questionId = `question_${Date.now()}`;
    const scopedOptions = questionOptions.slice(0, 8).map((option, index) => ({
      ...option,
      id: `${questionId}:option:${index}`,
      action: 'answer_question' as const,
      questionId,
    }));

    setVaultMessages(prev => [...prev, {
      sender: 'ai',
      text: questionPrompt,
      options: scopedOptions.length ? scopedOptions : undefined,
      questionPrompt,
      questionId,
      allowFreeTextReply: true,
      freeTextReplyPlaceholder: placeholder,
    }]);
  }, []);

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

  const tryHandleVaultFileListIntent = useCallback((messageText: string): boolean => {
    const wantsBulkOpen = isBulkVaultOpenIntent(messageText);
    const folderQuery = extractVaultFolderListQuery(messageText);
    if (!folderQuery && !wantsBulkOpen) {
      return false;
    }

    const fallbackDirectory =
      selectedDirectoryPath
      || (selectedFile ? getDirectoryForNodePath(selectedFile, fileTree, vaultPath) : null)
      || vaultActionRoot;

    const directoryCandidates = folderQuery
      ? suggestVaultDirectoryPaths(folderQuery, 6)
      : (fallbackDirectory ? [fallbackDirectory] : []);

    if (!directoryCandidates.length) {
      setVaultMessages(prev => [...prev, {
        sender: 'ai',
        text: folderQuery
          ? `I could not find a folder matching "${folderQuery}" in this vault. Try a more specific folder name.`
          : 'I could not determine which folder to use. Select a folder in the vault tree or mention one explicitly.'
      }]);
      return true;
    }

    if (directoryCandidates.length > 1) {
      const options: BrainChatOption[] = directoryCandidates.slice(0, 6).map(path => {
        const relative = toVaultRelativePath(path);
        return {
          id: `list_folder:${path}`,
          action: 'list_folder',
          value: path,
          label: (path.split(/[/\\]/).pop() || relative || path),
          description: relative,
        };
      });
      const lines = options
        .map((option, index) => `${index + 1}. ${option.description || option.label}`)
        .join('\n');

      setVaultMessages(prev => [...prev, {
        sender: 'ai',
        text: `I found multiple folders matching "${folderQuery}". Pick one folder below and I will list the files so you can choose exactly which note to open.\n\n${lines}`,
        options,
      }]);
      return true;
    }

      const selectedDirectory = directoryCandidates[0];
      const files = collectMarkdownFilesForDirectory(selectedDirectory, 120);
      if (!files.length) {
        const locationLabel = toVaultRelativePath(selectedDirectory) || '.';
        setVaultMessages(prev => [...prev, {
          sender: 'ai',
          text: `I found ${locationLabel}, but there are no markdown notes there.`
        }]);
        return true;
      }

    pushVaultOpenChoiceMessage(
      files,
      wantsBulkOpen
        ? `I can't open every file at once in Note mode. I found ${files.length} markdown ${files.length === 1 ? 'file' : 'files'} under ${toVaultRelativePath(selectedDirectory)}. Choose the exact file you want to open.`
        : `I found ${files.length} markdown ${files.length === 1 ? 'file' : 'files'} under ${toVaultRelativePath(selectedDirectory)}.`
    );
    return true;
  }, [collectMarkdownFilesForDirectory, extractVaultFolderListQuery, fileTree, pushVaultOpenChoiceMessage, selectedDirectoryPath, selectedFile, suggestVaultDirectoryPaths, toVaultRelativePath, vaultActionRoot, vaultPath]);

  const handleVaultMessageOptionSelect = useCallback(async (option: BrainChatOption, messageIndex: number) => {
    setVaultMessages(prev => prev.map((message, index) => (
      index === messageIndex ? { ...message, options: undefined } : message
    )));

    if (option.action === 'list_folder') {
      const files = collectMarkdownFilesForDirectory(option.value, 120);
      if (!files.length) {
        setVaultMessages(prev => [...prev, {
          sender: 'ai',
          text: `No markdown files found under ${toVaultRelativePath(option.value)}.`
        }]);
        return;
      }

      pushVaultOpenChoiceMessage(
        files,
        `I found ${files.length} markdown ${files.length === 1 ? 'file' : 'files'} under ${toVaultRelativePath(option.value)}.`
      );
      return;
    }

    if (option.action === 'open_note') {
      const resolvedTargetPath = await resolveVaultTargetPath(option.value);
      if (!resolvedTargetPath) {
        setVaultMessages(prev => [...prev, {
          sender: 'ai',
          text: `Could not locate ${option.description || option.label} anymore. Refresh the vault tree and try again.`
        }]);
        return;
      }

      setBrainScope('note');
      const opened = await openFile(resolvedTargetPath, true);
      setVaultMessages(prev => [...prev, {
        sender: 'ai',
        text: opened
          ? `Opened ${toVaultRelativePath(resolvedTargetPath)} in Note mode.`
          : `Found ${toVaultRelativePath(resolvedTargetPath)} but failed to open it.`
      }]);
    }
  }, [collectMarkdownFilesForDirectory, openFile, pushVaultOpenChoiceMessage, resolveVaultTargetPath, toVaultRelativePath]);

  // Load file tree on mount
  useEffect(() => {
    loadFileTree();
    if (selectedFile) {
      openFile(selectedFile);
    }
  }, [loadFileTree, openFile, selectedFile]);

  const saveFile = async () => {
    if (!selectedFile || !window.nexusAPI?.notes) return;
    const success = await window.nexusAPI.notes.writeFile(selectedFile, editContent);
    if (success) {
      cacheFileContent(selectedFile, editContent);
      setFileContent(editContent);
      setIsEditing(false);
      syncVaultSubtreeInBackground(selectedFile);
    }
  };

  // Handle checkbox toggle in read mode
  const handleCheckboxToggle = useCallback(async (lineIndex: number, checked: boolean) => {
    if (!selectedFile || !window.nexusAPI?.notes) return;

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
    const wrote = await window.nexusAPI.notes.writeFile(selectedFile, newContent);
    if (wrote) {
      syncVaultSubtreeInBackground(selectedFile);
    }
  }, [selectedFile, fileContent, syncVaultSubtreeInBackground]);

  const createNewFile = async () => {
    if (!newFileName.trim() || !window.nexusAPI?.notes) return;
    const result = await window.nexusAPI.notes.createFile(selectedDirectoryPath, normalizeMarkdownFileName(newFileName));
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
    if (!newFolderName.trim() || !window.nexusAPI?.notes) return;
    const result = await window.nexusAPI.notes.createFolder(selectedDirectoryPath, newFolderName.trim());
    if (result.success) {
      setShowNewFolderInput(false);
      setNewFolderName('');
      invalidateFileTreeCache(vaultPath);
      await loadFileTree();
      syncVaultSubtreeInBackground(result.path || selectedDirectoryPath);
    }
  };

  const handleFileDrop = async (sourcePath: string, targetPath: string): Promise<{ success: boolean; error?: string; newPath?: string }> => {
    if (!window.nexusAPI?.notes) {
      return { success: false, error: 'Notes API not available.' };
    }

    const resolvedSourcePath = await resolveVaultTargetPath(sourcePath, targetPath);
    if (!resolvedSourcePath) {
      return { success: false, error: `Could not locate source note: ${sourcePath}` };
    }

    if (!isMarkdownPath(resolvedSourcePath)) {
      console.warn('Blocked move for non-markdown file in Brain:', resolvedSourcePath);
      return { success: false, error: 'Only markdown notes can be moved in Brain.' };
    }

    const sourceNode = findNodeByPath(fileTree, resolvedSourcePath) || findNodeByPath(fileTree, sourcePath);
    if (sourceNode?.isDirectory) {
      return { success: false, error: 'Moving folders is not supported by this action.' };
    }

    const destinationDir = resolveVaultDestinationDirectory(targetPath);
    const sourceParent = getParentDirectory(resolvedSourcePath);
    if (sourceParent && areEquivalentPaths(sourceParent, destinationDir)) {
      return { success: false, error: 'Source note is already in that destination folder.' };
    }

    const ensureResult = await window.nexusAPI.notes.ensureDir(destinationDir);
    if (!ensureResult.success) {
      return { success: false, error: ensureResult.error || `Failed to access destination folder: ${destinationDir}` };
    }

    console.log(`Moving ${resolvedSourcePath} to ${destinationDir}`);

    const result = await window.nexusAPI.notes.moveFile(resolvedSourcePath, destinationDir);
    if (result.success) {
      invalidateFileTreeCache(vaultPath);
      syncVaultSubtreeInBackground(sourceParent || resolvedSourcePath);
      syncVaultSubtreeInBackground(destinationDir);
      await loadFileTree(true);

      if (selectedFile && areEquivalentPaths(selectedFile, resolvedSourcePath) && result.newPath) {
        await openFile(result.newPath, true);
      }

      return { success: true, newPath: result.newPath };
    }

    console.error('Move failed:', result.error);
    return { success: false, error: result.error || 'Unknown move failure.' };
  };

  const handleRename = async (oldPath: string, newName: string) => {
    if (!window.nexusAPI?.notes) return;
    const safeName = oldPath.toLowerCase().endsWith('.md') ? normalizeMarkdownFileName(newName) : newName.trim();
    const oldParent = getParentDirectory(oldPath) || vaultPath;
    const result = await window.nexusAPI.notes.rename(oldPath, safeName);
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
    window.nexusAPI?.settings?.brainCancelStream?.().catch((error: unknown) => {
      console.error('Failed to cancel Brain stream:', error);
    });
    setStreamingMsgIndex(null);
    setIsAiLoading(false);
    setCurrentMessages(prev => [...prev, { sender: 'ai', text: 'Response interrupted by user.' }]);
  };

  const clearChat = () => {
    const nextMessages = brainScope === 'vault'
      ? [{ sender: 'ai' as const, text: 'Vault chat cleared. Ask anything across your markdown vault.' }]
      : [{ sender: 'ai' as const, text: 'Chat cleared. How can I help you with this note?' }];
    setCurrentMessages(nextMessages);
    const chatKey = brainScope === 'vault' ? vaultChatRef.current : `brain_chat_${chatFileRef.current}`;
    localStorage.removeItem(chatKey);
  };

  const buildBrainVaultContext = useCallback((params: {
    userMessage: string;
    vaultSearch?: VaultSearchResult;
  }) => {
    const currentOpenNote = selectedFile ? toVaultRelativePath(selectedFile) : '(none)';
    const currentSelectedPath = selectedTreePath ? toVaultRelativePath(selectedTreePath) : '(none)';
    const includeCandidates = isVaultPathActionIntent(params.userMessage);
    const candidateFolders = includeCandidates
      ? suggestVaultDirectoryPaths(params.userMessage, 4).map(path => toVaultRelativePath(path))
      : [];
    const candidateNotes = includeCandidates
      ? suggestVaultNotePaths(params.userMessage, 4)
      : [];

    const candidateBlock = includeCandidates
      ? `\nTop folder candidates:\n${candidateFolders.length ? `- ${candidateFolders.join('\n- ')}` : '- none'}\n\nTop note candidates:\n${candidateNotes.length ? `- ${candidateNotes.join('\n- ')}` : '- none'}\n`
      : '';

    return `Vault path: ${vaultPath || '(not selected)'}
Index root: ${vaultActionRoot || '(not selected)'}
Current open note: ${currentOpenNote}
Current selected path: ${currentSelectedPath}${candidateBlock}

${params.vaultSearch?.promptContext || 'No vault search context available.'}`;
  }, [selectedFile, selectedTreePath, suggestVaultDirectoryPaths, suggestVaultNotePaths, toVaultRelativePath, vaultActionRoot, vaultPath]);

  const handleAiSend = async (
    messageText: string,
    sendOptions?: {
      displayUserText?: string;
      skipVaultFileListIntent?: boolean;
    }
  ) => {
    if (!messageText.trim() || isAiLoading) return;

    if (brainScope === 'vault' && !vaultPath) {
      setCurrentMessages(prev => [...prev, {
        sender: 'ai',
        text: 'Select a vault folder first. Vault mode cannot search or mutate notes until a vault is chosen.'
      }]);
      return;
    }

    if (aiProvider === 'nvidia' && !nvidiaApiKey) {
      setCurrentMessages(prev => [...prev, {
        sender: 'ai',
        text: 'NVIDIA API key is missing. Add it in Settings -> API Keys, or switch provider to local LM Studio.'
      }]);
      return;
    }

    abortControllerRef.current = new AbortController();

    const userMessage = messageText.trim();
    const userDisplayText = sendOptions?.displayUserText?.trim() || userMessage;
    const usedContext = selectedContext;
    const usedRange = selectionRange;
    const usedTiptapRange = tiptapRange;
    const wasEditing = isEditing;

    setCurrentMessages(prev => [...prev, { sender: 'user', text: userDisplayText, context: brainScope === 'note' ? (usedContext || undefined) : undefined }]);
    setSelectedContext('');
    setTiptapRange(null);
    setSelectionRange(null);
    setIsAiLoading(true);
    setProposedAction(null);
    if (brainScope === 'vault') {
      setVaultSearchMeta(null);
      setIsVaultSearchLoading(true);
      setVaultStatusMessage('Searching the markdown vault for matching notes and folders...');
    }

    if (brainScope === 'vault' && !sendOptions?.skipVaultFileListIntent && tryHandleVaultFileListIntent(userMessage)) {
      abortControllerRef.current = null;
      setIsVaultSearchLoading(false);
      setIsAiLoading(false);
      setVaultStatusMessage('Listed files directly from the current vault tree.');
      return;
    }

    try {
      const currentEditorContent = wasEditing ? editContent : fileContent;
      const fallbackModel = availableModels[0]?.id || DEFAULT_NIM_MODEL;
      const effectiveModel = availableModels.some(m => m.id === selectedModel)
        ? selectedModel
        : fallbackModel;

      let systemPrompt = '';
      let contextPayload = '';
      if (brainScope === 'vault') {
        const vaultSearch = await window.nexusAPI?.notes?.searchVault?.(vaultPath, userMessage, 8) as VaultSearchResult | undefined;
        if (vaultSearch) {
          setVaultSearchMeta(vaultSearch);
          const hitCount = vaultSearch.hits?.length || 0;
          setVaultStatusMessage(
            hitCount > 0
              ? `Found ${hitCount} vault match${hitCount === 1 ? '' : 'es'} across ${vaultSearch.indexedFiles} indexed notes.`
              : `Searched ${vaultSearch.indexedFiles} indexed notes but found no direct match for that query.`
          );
        } else {
          setVaultStatusMessage('Vault search returned no result metadata.');
        }
        systemPrompt = `You are Nexus Vault AI.

MODE:
VAULT MODE: search and organize the user's markdown vault.

Scope rules:
- Use only markdown note evidence from the provided vault context.
- The index root is fixed. Never use a destination outside that root.
- Do not invent files, folders, headings, or note contents.
- Prefer the current selected folder or current open note folder as the default destination when the user does not name one.
- Ask for destination clarification only when the user explicitly names a path and multiple strong matches exist.
- Never reveal hidden reasoning, chain-of-thought, or meta commentary.
- Do not write prefatory analysis like "The user asks", "According to instructions", or "In the vault evidence".
- If nothing relevant is found, answer briefly and directly in plain language.

Allowed JSON actions:
- create_note
- edit_note
- create_folder
- move_note
- open_note
- rename_note
- delete_item
- ask_question

Output rules:
- If no filesystem action is needed, respond in plain markdown only.
- If an action is needed, include exactly one JSON object wrapped in <nexus_action_json>...</nexus_action_json>.
- For create_note include: action, title, destination_path, content, explanation.
- For edit_note include: action, target_path, target_text (optional), content, explanation.
- For create_folder include: action, title, destination_path, explanation.
- For move_note include: action, source_path, destination_path, explanation.
- For open_note include: action, target_path, explanation.
- For rename_note include: action, target_path, new_name, explanation.
- For delete_item include: action, target_path, explanation.
- For ask_question include: action, question, options (array), allow_free_text (bool), free_text_placeholder (optional), explanation.
- If clarification is needed, do not ask a plain-text question; emit ask_question JSON.
- For open_note or edit_note, target_path must be an absolute path or a path relative to the index root.
- For create_note and edit_note also mirror markdown body in <nexus_content>...</nexus_content>.
- If destination is ambiguous after explicit user path input, emit ask_question instead of emitting a filesystem mutation.
- For open_note, edit_note, move_note, rename_note, and delete_item: if multiple path candidates are possible, emit ask_question with concrete path options.
- For create_note and create_folder: omit destination_path when the user did not specify one and rely on the current selected folder / open note folder / vault root default.
- For edit_note, if it is unclear whether user wants rewrite vs append vs section-only edits, emit ask_question first.
- Use provided candidate folders/notes when you must disambiguate.
- If destination evidence is weak, leave destination_path blank instead of inventing a folder.`;
        contextPayload = buildBrainVaultContext({
          userMessage,
          vaultSearch,
        });
      } else {
        const currentEditorContent = wasEditing ? editContent : fileContent;
        const isSelectionActive = Boolean(usedContext && usedContext.trim());
        contextPayload = selectedFile
          ? buildBrainNoteContext({
            content: currentEditorContent,
            userMessage,
            notePath: selectedFile,
            selectedText: usedContext || undefined,
            selectedRange: usedRange || undefined,
          })
          : 'No note currently open.';

        systemPrompt = aiMode === 'edit'
          ? `You are Nexus AI, an editor assistant with an orchestration layer.\n\nMODE:\nEDIT MODE: return precise edit actions.\n\nYou are given cleaned note context built from the current note only. Use the ACTIVE SELECTION first when it exists; it is the highest-priority target and should override older chat context.\n\nOutput rules:\n- Always include ONE JSON object at the end of the response.\n- Wrap the JSON in <nexus_action_json>...</nexus_action_json> tags.\n- JSON action must be one of: insert_content, create_note, replace_selection, insert_at_cursor, find_and_replace, replace_all, ask_question.\n- For find_and_replace, include exact target_text from the provided note context.\n- For any edit action, content must be non-empty and must be the exact insertion text.\n- For replace_all, content must be the complete final note.\n- Never use replace_all unless the user explicitly requested full rewrite or whole-note reformatting.\n- If intent is ambiguous (rewrite vs append vs section edit, or target section unclear), use ask_question first.\n- If clarification is needed, do not ask a plain-text question; emit ask_question JSON.\n- Also include the same insertion body in <nexus_content>...</nexus_content> tags for write actions.\n- Do not duplicate sections or reintroduce older content that is not in the current note context.\n- Keep explanation short and concrete.\n\nJSON schema:\n<nexus_action_json>\n{\n  "action": "find_and_replace",\n  "target_text": "exact text",\n  "content": "replacement",\n  "explanation": "why"\n}\n</nexus_action_json>\n\nClarification schema (when uncertain):\n<nexus_action_json>\n{\n  "action": "ask_question",\n  "question": "What should I do in this note?",\n  "options": [\n    { "label": "Add a new section", "value": "add_section" },\n    { "label": "Edit existing section only", "value": "edit_section" },\n    { "label": "Rewrite whole note", "value": "rewrite_note" }\n  ],\n  "allow_free_text": true,\n  "free_text_placeholder": "Type custom instructions",\n  "explanation": "Need clarification before editing"\n}\n</nexus_action_json>\n\nOptional content mirror:\n<nexus_content>\nreplacement\n</nexus_content>\n\nSelection constraints:\n${isSelectionActive
            ? (wasEditing
              ? 'User selected text in editor. Prefer replace_selection.'
              : 'User selected text in rendered view. Prefer find_and_replace with exact raw markdown target_text.')
            : 'No explicit selection. Use insert_at_cursor for additions; use replace_all only for full rewrites.'}`
          : `You are Nexus AI, a teaching assistant with an orchestration layer.\n\nMODE:\nLECTURE MODE: teach only.\n\nYou are given cleaned note context built from the current note only. Use the ACTIVE SELECTION first when it exists and do not drift to older unrelated chat or note content.\n\nOutput rules:\n- Explain and teach in plain markdown.\n- Do NOT output any JSON object.\n- Do NOT output <nexus_action_json> or <nexus_content> tags.\n- Do NOT propose file edits, replacements, or apply/discard style actions.\n- Keep the response instructional, concrete, and structured.`;
      }

      const buildMessages = () => {
        const convoContext = buildModelConversation(currentMessages, brainScope === 'note' ? aiMode : 'lecture');
        return [
          { role: 'system', content: systemPrompt },
          ...convoContext,
          { role: 'user', content: `${userMessage}\n\nCONTEXT:\n${contextPayload}` }
        ];
      };

      // --- TRUE STREAMING via Rust backend (brain://token events) ---
      // This mirrors exactly how ChatPage works: the Rust command makes the HTTP request
      // (no CORS) and emits brain://token for each SSE chunk. We listen and append tokens
      // to the bubble live - genuine token-by-token streaming.
      let aiResponse = '';
      let msgIdx = -1;

      setCurrentMessages(prev => {
        const newMsg: BrainChatMessage = { sender: 'ai' as const, text: '' };
        const next = [...prev, newMsg];
        msgIdx = next.length - 1;
        return next;
      });
      setStreamingMsgIndex(msgIdx);

      const isLocal = aiProvider === 'local' || aiProvider === 'lmstudio';
      const msgs = buildMessages();

      // Listen for tokens before calling so we don't miss any
      const unlistenToken = await listen<string>('brain://token', (event) => {
        aiResponse += event.payload;
        setCurrentMessages(prev => {
          const next = [...prev];
          const msg = next[msgIdx];
          if (msg && msg.sender === 'ai') {
            next[msgIdx] = { ...msg, text: msg.text + event.payload };
          }
          return next;
        });
      });

      try {
        await window.nexusAPI!.settings!.brainChatStream!(
          effectiveModel,
          msgs,
          isLocal,
          65536,
          aiMode === 'edit' ? 0.15 : 0.45,
        );
      } catch (err: any) {
        // Remove the empty bubble on error
        setCurrentMessages(prev => prev.filter((_, i) => i !== msgIdx));
        setStreamingMsgIndex(null);
        throw err;
      } finally {
        unlistenToken();
      }

      if (!aiResponse.trim()) {
        aiResponse = 'Sorry, I could not generate a response.';
      }
      const visibleAiResponse = sanitizeVisibleBrainResponse(aiResponse);
      const finalMessageText = aiResponse.trim() ? aiResponse : visibleAiResponse;
      const fallbackVisibleResponse = brainScope === 'vault'
        ? 'I can help with your vault. What would you like to do?'
        : 'I can help with this note. What would you like to do?';
      setCurrentMessages(prev => {
        const next = [...prev];
        if (next[msgIdx]) next[msgIdx] = { ...next[msgIdx], text: finalMessageText || fallbackVisibleResponse };
        return next;
      });
      setStreamingMsgIndex(null);


      if (brainScope === 'note' && aiMode !== 'edit') {
        setProposedAction(null);
        return;
      }

      const actionData = parseActionPayload(aiResponse);
      const validActions: BrainActionType[] = brainScope === 'vault'
        ? ['create_note', 'edit_note', 'create_folder', 'move_note', 'open_note', 'rename_note', 'delete_item', 'ask_question']
        : ['insert_content', 'create_note', 'replace_selection', 'insert_at_cursor', 'find_and_replace', 'replace_all', 'ask_question'];

      if (actionData?.action && validActions.includes(actionData.action)) {
        const pushClarificationQuestionOnLastMessage = (
          questionPrompt: string,
          questionOptions: BrainChatOption[],
          placeholder = 'Type your answer'
        ) => {
          const questionId = `question_${Date.now()}`;
          const scopedOptions = questionOptions.map((option, index) => ({
            ...option,
            id: `${questionId}:option:${index}`,
            action: 'answer_question' as const,
            questionId,
          }));

          setCurrentMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.sender === 'ai') {
              last.isAction = false;
              last.text = questionPrompt;
              last.options = scopedOptions;
              last.questionPrompt = questionPrompt;
              last.questionId = questionId;
              last.allowFreeTextReply = true;
              last.freeTextReplyPlaceholder = placeholder;
            }
            return next;
          });
        };

        const setLastAiActionMessage = (text: string, options?: BrainChatOption[]) => {
          setCurrentMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.sender === 'ai') {
              last.isAction = !options?.length;
              last.text = text;
              last.options = options;
              last.questionPrompt = undefined;
              last.questionId = undefined;
              last.allowFreeTextReply = undefined;
              last.freeTextReplyPlaceholder = undefined;
            }
            return next;
          });
        };

        if (actionData.action === 'ask_question') {
          const questionId = (actionData.question_id || `question_${Date.now()}`).trim();
          const questionPrompt = (actionData.question || actionData.explanation || visibleAiResponse || '').trim()
            || 'I need a quick clarification before I proceed.';
          const questionOptions = normalizeClarificationOptions(actionData.options, questionId);
          const allowFreeTextReply = actionData.allow_free_text !== false;
          const freeTextReplyPlaceholder = actionData.free_text_placeholder?.trim() || 'Type your answer';

          setCurrentMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.sender === 'ai') {
              last.isAction = false;
              last.text = questionPrompt;
              last.options = questionOptions.length ? questionOptions : undefined;
              last.questionPrompt = questionPrompt;
              last.questionId = questionId;
              last.allowFreeTextReply = allowFreeTextReply;
              last.freeTextReplyPlaceholder = freeTextReplyPlaceholder;
            }
            return next;
          });

          setProposedAction(null);
          return;
        }

        if (actionData.action === 'replace_all' && !isExplicitWholeRewriteIntent(userMessage)) {
          pushClarificationQuestionOnLastMessage(
            'Before I edit this note, should I rewrite the whole note or only update a section?',
            [
              { id: 'clarify:section_edit', action: 'answer_question', label: 'Update a section only', value: 'update_section_only' },
              { id: 'clarify:add_section', action: 'answer_question', label: 'Add a new section', value: 'add_new_section' },
              { id: 'clarify:rewrite_whole', action: 'answer_question', label: 'Rewrite the whole note', value: 'rewrite_whole_note' },
            ],
            'Tell me exactly which part to edit (or say rewrite whole note)'
          );
          setProposedAction(null);
          return;
        }

        if (actionData.action === 'edit_note' && !actionData.target_text?.trim() && !isExplicitWholeRewriteIntent(userMessage)) {
          pushClarificationQuestionOnLastMessage(
            'For this file edit, do you want to append content, edit an existing section, or rewrite the whole note?',
            [
              { id: 'clarify:append', action: 'answer_question', label: 'Append new content', value: 'append_content' },
              { id: 'clarify:edit_existing', action: 'answer_question', label: 'Edit existing section', value: 'edit_existing_section' },
              { id: 'clarify:rewrite', action: 'answer_question', label: 'Rewrite whole note', value: 'rewrite_whole_note' },
            ],
            'If editing existing text, mention heading/snippet to target'
          );
          setProposedAction(null);
          return;
        }

        if (brainScope === 'vault') {
          const normalizedTitle = actionData.action === 'create_note' && actionData.title
            ? normalizeMarkdownFileName(actionData.title)
            : (actionData.new_name?.trim() || actionData.title?.trim());
          const resolvedVaultContent = (actionData.action === 'create_note' || actionData.action === 'edit_note')
            ? (sanitizeProposedMarkdown(actionData.content) || inferActionContentFromResponse(actionData.action, aiResponse))
            : undefined;

          let resolvedSourcePath = actionData.source_path?.trim();
          let resolvedTargetPath = actionData.target_path?.trim();
          const destinationResolution = resolveVaultDestinationWithConfidence(actionData.destination_path, 6);
          let resolvedDestinationPath = destinationResolution.resolvedPath || vaultActionRoot;
          const destinationWasExplicitlyProvided = Boolean(actionData.destination_path?.trim());
          const usesDefaultDestination = actionData.action === 'create_note' || actionData.action === 'create_folder';

          if (actionData.action === 'open_note' && isBulkVaultOpenIntent(userMessage)) {
            const preferredDirectory =
              (resolvedDestinationPath && resolveVaultDestinationDirectory(resolvedDestinationPath))
              || selectedDirectoryPath
              || (selectedFile ? getDirectoryForNodePath(selectedFile, fileTree, vaultPath) : null)
              || vaultActionRoot;

            const files = preferredDirectory ? collectMarkdownFilesForDirectory(preferredDirectory, 120) : [];
            if (files.length) {
              const previewLimit = 12;
              const previewLines = files
                .slice(0, previewLimit)
                .map((path, index) => `${index + 1}. ${toVaultRelativePath(path)}`)
                .join('\n');
              const moreCount = files.length - previewLimit;
              setLastAiActionMessage(
                `I can't open every file at once in Note mode. Choose exactly which file you want from ${toVaultRelativePath(preferredDirectory)}.\n\n${previewLines}${moreCount > 0 ? `\n...and ${moreCount} more.` : ''}`,
                buildVaultOpenOptions(files, 8)
              );
            } else {
              pushClarificationQuestionOnLastMessage(
                'I can open one note at a time. Which file do you want me to open?',
                buildVaultAnswerOptionsFromPaths(collectMarkdownPaths(fileTree, 6), 'Use target_path', 6),
                'Type the exact note path to open'
              );
            }
            setProposedAction(null);
            return;
          }

          const shouldClarifyDestination = destinationWasExplicitlyProvided
            && (
              !destinationResolution.resolvedPath
              || (
                !usesDefaultDestination
                && destinationResolution.confidence !== 'high'
                && destinationResolution.candidates.length > 1
              )
            );
          if (shouldClarifyDestination) {
            const destinationOptions = buildVaultAnswerOptionsFromPaths(
              destinationResolution.candidates.length
                ? destinationResolution.candidates
                : getVaultDirectoryCandidates(8),
              'Use destination_path',
              6,
            );
            pushClarificationQuestionOnLastMessage(
              destinationResolution.candidates.length
                ? `I found multiple destination folders for "${actionData.destination_path}". Which folder should I use?`
                : `I could not match "${actionData.destination_path}" to a vault folder. Which folder should I use instead?`,
              destinationOptions,
              'Type the exact destination folder path'
            );
            setProposedAction(null);
            return;
          }

          if (actionData.action === 'move_note') {
            if (!resolvedSourcePath) {
              pushClarificationQuestionOnLastMessage(
                'Which note should I move?',
                buildVaultAnswerOptionsFromPaths(collectMarkdownPaths(fileTree, 6), 'Use source_path', 6),
                'Type the source note path to move'
              );
              setProposedAction(null);
              return;
            }

            const sourceResolution = await resolveVaultFilePathWithConfidence(resolvedSourcePath, actionData.destination_path, 6);
            const shouldClarifySource = !sourceResolution.resolvedPath
              || (sourceResolution.confidence !== 'high' && sourceResolution.candidates.length > 1);
            if (shouldClarifySource) {
              const sourceOptions = buildVaultAnswerOptionsFromPaths(
                sourceResolution.candidates.length
                  ? sourceResolution.candidates
                  : collectMarkdownPaths(fileTree, 8),
                'Use source_path',
                6,
              );
              pushClarificationQuestionOnLastMessage(
                `I found multiple source notes for "${sourceResolution.requestedPath}". Which note should I move?`,
                sourceOptions,
                'Type the exact source note path to move'
              );
              setProposedAction(null);
              return;
            }

            resolvedSourcePath = sourceResolution.resolvedPath || resolvedSourcePath;
            resolvedDestinationPath = destinationResolution.resolvedPath || resolvedDestinationPath;
          }

          if ((actionData.action === 'open_note' || actionData.action === 'edit_note') && resolvedTargetPath) {
            const targetResolution = await resolveVaultFilePathWithConfidence(resolvedTargetPath, actionData.destination_path, 6);
            const shouldClarifyTarget = !targetResolution.resolvedPath
              || (targetResolution.confidence !== 'high' && targetResolution.candidates.length > 1);
            if (shouldClarifyTarget) {
              const targetOptions = buildVaultAnswerOptionsFromPaths(
                targetResolution.candidates.length
                  ? targetResolution.candidates
                  : collectMarkdownPaths(fileTree, 8),
                'Use target_path',
                6,
              );
              pushClarificationQuestionOnLastMessage(
                `I found multiple notes for "${targetResolution.requestedPath}". Which note should I ${actionData.action === 'open_note' ? 'open' : 'edit'}?`,
                targetOptions,
                'Type the exact note path to use'
              );
              setProposedAction(null);
              return;
            }

            resolvedTargetPath = targetResolution.resolvedPath || resolvedTargetPath;
          }

          if ((actionData.action === 'rename_note' || actionData.action === 'delete_item') && resolvedTargetPath) {
            const nodeResolution = resolveVaultNodePathWithConfidence(resolvedTargetPath, actionData.destination_path, 6);
            const shouldClarifyNode = !nodeResolution.resolvedPath
              || (nodeResolution.confidence !== 'high' && nodeResolution.candidates.length > 1);
            if (shouldClarifyNode) {
              const nodeOptions = buildVaultAnswerOptionsFromPaths(
                nodeResolution.candidates.length
                  ? nodeResolution.candidates
                  : [
                    ...collectMarkdownPaths(fileTree, 5),
                    ...getVaultDirectoryCandidates(5),
                  ],
                'Use target_path',
                6,
              );
              pushClarificationQuestionOnLastMessage(
                `I found multiple matches for "${nodeResolution.requestedPath}". Which file or folder should I ${actionData.action === 'rename_note' ? 'rename' : 'delete'}?`,
                nodeOptions,
                'Type the exact file or folder path to use'
              );
              setProposedAction(null);
              return;
            }

            resolvedTargetPath = nodeResolution.resolvedPath || resolvedTargetPath;
          }

          if ((actionData.action === 'open_note' || actionData.action === 'edit_note' || actionData.action === 'rename_note' || actionData.action === 'delete_item') && !resolvedTargetPath) {
            pushClarificationQuestionOnLastMessage(
              `I need the exact target path before I can ${actionData.action.replace('_', ' ')}. Which file or folder should I use?`,
              buildVaultAnswerOptionsFromPaths(
                [...collectMarkdownPaths(fileTree, 6), ...getVaultDirectoryCandidates(4)],
                'Use target_path',
                6,
              ),
              'Type the exact target path'
            );
            setProposedAction(null);
            return;
          }

          if ((actionData.action === 'create_note' || actionData.action === 'edit_note') && (!resolvedVaultContent || !resolvedVaultContent.trim())) {
            setCurrentMessages(prev => [...prev, {
              sender: 'ai',
              text: 'Could not extract markdown content for this vault write action. Please retry with explicit content.'
            }]);
            return;
          }

          setLastAiActionMessage(buildBrainActionPreview(actionData));

          setProposedAction({
            scope: 'vault',
            type: actionData.action === 'create_note'
              ? 'create'
              : actionData.action === 'edit_note'
                ? 'edit_note'
              : actionData.action === 'create_folder'
                ? 'create_folder'
                : actionData.action === 'move_note'
                  ? 'move_note'
                  : actionData.action === 'rename_note'
                    ? 'rename_note'
                    : actionData.action === 'delete_item'
                      ? 'delete_item'
                      : 'open_note',
            content: resolvedVaultContent,
            target_text: actionData.target_text,
            title: normalizedTitle,
            message: actionData.explanation || 'Confirm this vault action?',
            sourceFile: selectedFile,
            sourcePath: resolvedSourcePath,
            destinationPath: resolvedDestinationPath,
            targetPath: resolvedTargetPath || resolvedSourcePath,
          });
          return;
        }

        const sanitizedActionContent = sanitizeProposedMarkdown(actionData.content, { aggressive: actionData.action !== 'replace_all' });
        const resolvedContent = sanitizedActionContent || inferActionContentFromResponse(actionData.action, aiResponse);
        const contentRequiredActions: BrainActionType[] = ['replace_all', 'replace_selection', 'find_and_replace', 'insert_content', 'insert_at_cursor'];

        if (contentRequiredActions.includes(actionData.action) && (!resolvedContent || !resolvedContent.trim())) {
          setCurrentMessages(prev => [...prev, {
            sender: 'ai',
            text: 'Could not extract insertion content from the response. Retrying with strict JSON/tagged output should fix this.'
          }]);
          return;
        }

        setLastAiActionMessage(buildBrainActionPreview(actionData));

        const replaceAllTarget = (actionData.target_text || currentEditorContent || fileContent || editContent || '').toString();
        setProposedAction({
          scope: 'note',
          type: actionData.action === 'insert_content' ? 'insert' : (actionData.action === 'create_note' ? 'create' : actionData.action) as any,
          content: resolvedContent,
          target_text: actionData.action === 'replace_all' ? replaceAllTarget : (actionData.target_text || usedContext),
          originalSelection: usedContext || undefined,
          title: actionData.title,
          message: actionData.explanation,
          sourceFile: selectedFile,
          range: usedRange || usedTiptapRange
        });
      }

      if (!actionData?.action && (brainScope === 'vault' || aiMode === 'edit') && isAmbiguousOperationRequest(userMessage)) {
        const questionId = `question_${Date.now()}`;
        const fallbackQuestion = looksLikeClarificationQuestion(visibleAiResponse)
          ? visibleAiResponse
          : (brainScope === 'vault'
            ? 'I need one clarification before changing notes. What exactly should I do?'
            : 'I need one clarification before editing this note. What exactly should I do?');

        const fallbackOptions: BrainChatOption[] = brainScope === 'vault'
          ? [
            {
              id: `${questionId}:option:0`,
              action: 'answer_question',
              label: selectedFile ? `Edit current note (${selectedFile.split(/[/\\]/).pop() || 'current'})` : 'Edit an existing note',
              value: selectedFile ? 'edit_current_note' : 'edit_existing_note',
              questionId,
            },
            {
              id: `${questionId}:option:1`,
              action: 'answer_question',
              label: 'Add a new section',
              value: 'add_new_section',
              questionId,
            },
            {
              id: `${questionId}:option:2`,
              action: 'answer_question',
              label: 'Create a new note',
              value: 'create_new_note',
              questionId,
            },
            {
              id: `${questionId}:option:3`,
              action: 'answer_question',
              label: 'Move / Rename / Delete a note',
              value: 'organize_notes',
              questionId,
            },
          ]
          : [
            {
              id: `${questionId}:option:0`,
              action: 'answer_question',
              label: 'Edit selected section only',
              value: 'edit_selected_section',
              questionId,
            },
            {
              id: `${questionId}:option:1`,
              action: 'answer_question',
              label: 'Add a new section',
              value: 'add_new_section',
              questionId,
            },
            {
              id: `${questionId}:option:2`,
              action: 'answer_question',
              label: 'Rewrite the whole note',
              value: 'rewrite_whole_note',
              questionId,
            },
            {
              id: `${questionId}:option:3`,
              action: 'answer_question',
              label: 'Create a new note instead',
              value: 'create_new_note',
              questionId,
            },
          ];

        setCurrentMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.sender === 'ai') {
            last.isAction = false;
            last.text = fallbackQuestion;
            last.options = fallbackOptions;
            last.questionPrompt = fallbackQuestion;
            last.questionId = questionId;
            last.allowFreeTextReply = true;
            last.freeTextReplyPlaceholder = 'Tell me exactly what to edit, which file, and what to add/change';
          }
          return next;
        });

        setProposedAction(null);
        return;
      }

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Fetch aborted');
        return;
      }
      console.error('AI API error:', error);
      if (brainScope === 'vault') {
        setVaultStatusMessage(`Vault search/chat failed. ${getErrorMessage(error)}`);
      }
      setCurrentMessages(prev => [...prev, {
        sender: 'ai',
        text: `AI request failed. ${getErrorMessage(error)}`
      }]);
    } finally {
      if (brainScope === 'vault') {
        setIsVaultSearchLoading(false);
      }
      setIsAiLoading(false);
    }
  };

  const submitClarificationAnswer = useCallback((params: {
    answer: string;
    messageIndex: number;
    questionPrompt?: string;
    questionId?: string;
  }) => {
    const answer = params.answer.trim();
    if (!answer || isAiLoading) return;

    const clearControls = (messages: BrainChatMessage[]) => messages.map((message, index) => (
      index === params.messageIndex
        ? {
          ...message,
          options: undefined,
          allowFreeTextReply: false,
          freeTextReplyPlaceholder: undefined,
        }
        : message
    ));

    if (brainScope === 'vault') {
      setVaultMessages(prev => clearControls(prev));
    } else {
      setAiMessages(prev => clearControls(prev));
    }

    const questionPrompt = (params.questionPrompt || 'Clarification needed').trim();
    const questionId = (params.questionId || `question_${Date.now()}`).trim();
    const followUp = `CLARIFICATION_RESPONSE
question_id: ${questionId}
question: ${questionPrompt}
answer: ${answer}

Use this clarification to complete the previous user request with one precise action. If anything is still ambiguous, ask one narrower ask_question follow-up.`;

    void handleAiSend(followUp, {
      displayUserText: answer,
      skipVaultFileListIntent: true,
    });
  }, [brainScope, handleAiSend, isAiLoading]);

  const handleChatOptionSelect = useCallback((
    option: BrainChatOption,
    messageIndex: number,
    questionPrompt?: string,
    questionId?: string,
  ) => {
    if (option.action === 'answer_question') {
      submitClarificationAnswer({
        answer: option.value || option.label,
        messageIndex,
        questionPrompt,
        questionId: option.questionId || questionId,
      });
      return;
    }

    if (brainScope === 'vault') {
      void handleVaultMessageOptionSelect(option, messageIndex);
    }
  }, [brainScope, handleVaultMessageOptionSelect, submitClarificationAnswer]);

  const handleChatFreeTextReply = useCallback((
    reply: string,
    messageIndex: number,
    questionPrompt?: string,
    questionId?: string,
  ) => {
    submitClarificationAnswer({
      answer: reply,
      messageIndex,
      questionPrompt,
      questionId,
    });
  }, [submitClarificationAnswer]);

  const handleApplyAction = async () => {
    if (!proposedAction || !window.nexusAPI?.notes) return;
    if (proposedAction.scope === 'vault') {
      try {
        if (proposedAction.type === 'create') {
          const title = normalizeMarkdownFileName(proposedAction.title || 'Untitled note.md');
          const destination = resolveVaultDestinationDirectory(proposedAction.destinationPath);
          const ensureDestination = await window.nexusAPI.notes.ensureDir(destination);
          if (!ensureDestination.success) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Could not access destination folder ${destination}: ${ensureDestination.error || 'unknown error'}`
            }]);
            return;
          }

          const result = await window.nexusAPI.notes.createFile(destination, title);
          if (!result.success || !result.path) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Create note failed: ${result.error || 'unknown error'}`
            }]);
            return;
          }

          const wrote = await window.nexusAPI.notes.writeFile(result.path, proposedAction.content || '');
          if (!wrote) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Created ${title}, but writing markdown content failed for ${toVaultRelativePath(result.path)}.`
            }]);
            return;
          }

          invalidateFileTreeCache(vaultPath);
          syncVaultSubtreeInBackground(result.path);
          void loadFileTree(true);
          setBrainScope('note');
          await openFile(result.path, true);
          setVaultMessages(prev => [...prev, {
            sender: 'ai',
            text: `Created ${toVaultRelativePath(result.path)}.`
          }]);
        } else if (proposedAction.type === 'edit_note') {
          if (!proposedAction.targetPath) {
            setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing target_path for edit action.' }]);
            return;
          }

          const resolvedTargetPath = await resolveVaultTargetPath(proposedAction.targetPath, proposedAction.destinationPath);
          if (!resolvedTargetPath) {
            const openChoices = resolveVaultOpenChoicePaths(proposedAction.targetPath, proposedAction.destinationPath, 24);
            if (openChoices.length) {
              pushVaultOpenChoiceMessage(
                openChoices,
                `Could not locate an exact match for "${proposedAction.targetPath}". Here are likely files:`
              );
            } else {
              const suggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
              const suggestionText = suggestions.length ? ` Try one of: ${suggestions.join(', ')}` : '';
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Could not locate ${proposedAction.targetPath} inside the current vault root.${suggestionText}`
              }]);
            }
            return;
          }

          const existingContent = await window.nexusAPI.notes.readFile(resolvedTargetPath);
          if (existingContent === null) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Found ${toVaultRelativePath(resolvedTargetPath)} but failed to read it.`
            }]);
            return;
          }

          const replacement = sanitizeProposedMarkdown(proposedAction.content, { aggressive: false }) || proposedAction.content || '';
          if (!replacement.trim()) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: 'Edit action has no markdown content to write.'
            }]);
            return;
          }

          let updatedContent = existingContent;
          let editOutcome = 'Updated note.';

          if (proposedAction.target_text?.trim()) {
            const targetText = proposedAction.target_text;
            if (updatedContent.includes(targetText)) {
              updatedContent = updatedContent.replace(targetText, replacement);
              editOutcome = 'Replaced the requested section.';
            } else {
              const flexiblePattern = escapeRegExp(targetText.trim()).replace(/\s+/g, '\\s+');
              const flexibleRegex = new RegExp(flexiblePattern, 'm');
              if (flexibleRegex.test(updatedContent)) {
                updatedContent = updatedContent.replace(flexibleRegex, replacement);
                editOutcome = 'Replaced a whitespace-normalized section.';
              } else {
                pushVaultClarificationQuestion(
                  `I could not find the exact target text in ${toVaultRelativePath(resolvedTargetPath)}. How should I continue this edit?`,
                  [
                    { id: 'clarify:append_end', action: 'answer_question', label: 'Append at end', value: 'append_at_end' },
                    { id: 'clarify:pick_section', action: 'answer_question', label: 'Pick target section first', value: 'pick_target_section' },
                    { id: 'clarify:rewrite', action: 'answer_question', label: 'Rewrite whole note', value: 'rewrite_whole_note' },
                  ],
                  'Provide the exact heading or text snippet to replace'
                );
                return;
              }
            }
          } else {
            const trimmedReplacement = replacement.trim();
            const existingHeadings = extractMarkdownHeadingTitles(updatedContent);
            const replacementHeadings = extractMarkdownHeadingTitles(trimmedReplacement);
            const duplicateHeadings = replacementHeadings.filter(heading => existingHeadings.includes(heading));

            if (duplicateHeadings.length) {
              pushVaultClarificationQuestion(
                `This edit may duplicate existing section headings (${duplicateHeadings.slice(0, 3).join(', ')}). Where should I apply it?`,
                [
                  { id: 'clarify:edit_existing_section', action: 'answer_question', label: 'Edit existing section', value: 'edit_existing_section' },
                  { id: 'clarify:append_anyway', action: 'answer_question', label: 'Append anyway', value: 'append_anyway' },
                  { id: 'clarify:rewrite_after_review', action: 'answer_question', label: 'Rewrite whole note', value: 'rewrite_whole_note' },
                ],
                'Tell me which heading to target to avoid duplicates'
              );
              return;
            }

            if (trimmedReplacement && !updatedContent.includes(trimmedReplacement)) {
              updatedContent = `${updatedContent.replace(/\s*$/, '')}\n\n${trimmedReplacement}\n`;
              editOutcome = 'No target_text provided, so content was appended at the end.';
            } else {
              editOutcome = 'No changes applied because the proposed content already exists in the note.';
            }
          }

          if (updatedContent === existingContent) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `No file changes were needed for ${toVaultRelativePath(resolvedTargetPath)}. ${editOutcome}`
            }]);
            return;
          }

          const wrote = await window.nexusAPI.notes.writeFile(resolvedTargetPath, updatedContent);
          if (!wrote) {
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Failed to write updates to ${toVaultRelativePath(resolvedTargetPath)}.`
            }]);
            return;
          }

          cacheFileContent(resolvedTargetPath, updatedContent);
          if (selectedFile && areEquivalentPaths(selectedFile, resolvedTargetPath)) {
            setFileContent(updatedContent);
            setEditContent(updatedContent);
          }

          syncVaultSubtreeInBackground(resolvedTargetPath);
          setVaultMessages(prev => [...prev, {
            sender: 'ai',
            text: `${editOutcome} Saved to ${toVaultRelativePath(resolvedTargetPath)}.`
          }]);
        } else if (proposedAction.type === 'create_folder') {
          const destination = resolveVaultDestinationDirectory(proposedAction.destinationPath);
          const folderName = (proposedAction.title || '').trim();
          if (!folderName) {
            setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing folder name. No changes were applied.' }]);
          } else {
            const ensureDestination = await window.nexusAPI.notes.ensureDir(destination);
            if (!ensureDestination.success) {
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Could not access parent folder ${destination}: ${ensureDestination.error || 'unknown error'}`
              }]);
              return;
            }
            const result = await window.nexusAPI.notes.createFolder(destination, folderName);
            if (result.success) {
              const createdFolderPath = result.path || joinFileSystemPath(destination, folderName);
              invalidateFileTreeCache(vaultPath);
              void loadFileTree(true);
              syncVaultSubtreeInBackground(createdFolderPath);
              setVaultMessages(prev => [...prev, { sender: 'ai', text: `Created folder ${folderName} in ${toVaultRelativePath(destination)}.` }]);
            } else {
              setVaultMessages(prev => [...prev, { sender: 'ai', text: `Create folder failed: ${result.error || 'unknown error'}` }]);
            }
          }
        } else if (proposedAction.type === 'move_note') {
          if (!proposedAction.sourcePath) {
            setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing source_path for move action.' }]);
          } else {
            const destination = proposedAction.destinationPath || vaultActionRoot;
            const moveResult = await handleFileDrop(proposedAction.sourcePath, destination);
            if (!moveResult.success) {
              const suggestions = suggestVaultNotePaths(proposedAction.sourcePath, 4);
              const suggestionText = suggestions.length ? ` Closest notes: ${suggestions.join(', ')}` : '';
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Move failed: ${moveResult.error || 'unknown error'}.${suggestionText}`
              }]);
              return;
            }

            const movedPath = moveResult.newPath ? toVaultRelativePath(moveResult.newPath) : null;
            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: movedPath
                ? `Moved note to ${movedPath}.`
                : `Moved note into ${toVaultRelativePath(resolveVaultDestinationDirectory(destination))}.`
            }]);
          }
        } else if (proposedAction.type === 'rename_note') {
          if (!proposedAction.targetPath) {
            setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing target_path for rename action.' }]);
          } else {
            const resolvedTargetPath = resolveVaultExistingNodePath(proposedAction.targetPath, proposedAction.destinationPath);
            if (!resolvedTargetPath) {
              const noteSuggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
              const dirSuggestions = suggestVaultDirectoryPaths(proposedAction.targetPath, 4)
                .map(path => toVaultRelativePath(path));
              const combinedSuggestions = [...noteSuggestions, ...dirSuggestions].slice(0, 5);
              const suggestionText = combinedSuggestions.length ? ` Try one of: ${combinedSuggestions.join(', ')}` : '';
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Could not locate ${proposedAction.targetPath} for rename.${suggestionText}`
              }]);
              return;
            }

            const nextNameRaw = (proposedAction.title || '').trim();
            if (!nextNameRaw) {
              setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing new_name/title for rename action.' }]);
              return;
            }

            const safeName = resolvedTargetPath.toLowerCase().endsWith('.md')
              ? normalizeMarkdownFileName(nextNameRaw)
              : nextNameRaw;

            const renameResult = await window.nexusAPI.notes.rename(resolvedTargetPath, safeName);
            if (!renameResult.success) {
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Rename failed: ${renameResult.error || 'unknown error'}`
              }]);
              return;
            }

            const oldParent = getParentDirectory(resolvedTargetPath) || vaultPath;
            const newPath = renameResult.newPath || resolvedTargetPath;
            invalidateFileTreeCache(vaultPath);
            void loadFileTree(true);
            syncVaultSubtreeInBackground(oldParent);
            syncVaultSubtreeInBackground(getParentDirectory(newPath) || newPath);

            if (selectedFile && areEquivalentPaths(selectedFile, resolvedTargetPath) && renameResult.newPath) {
              await openFile(renameResult.newPath, true);
            } else if (selectedFile && renameResult.newPath && pathIsWithin(selectedFile, resolvedTargetPath)) {
              const oldPrefix = stripWindowsExtendedPathPrefix(resolvedTargetPath).replace(/[\\/]+$/, '');
              const newPrefix = stripWindowsExtendedPathPrefix(renameResult.newPath).replace(/[\\/]+$/, '');
              const normalizedSelected = stripWindowsExtendedPathPrefix(selectedFile);
              const suffix = normalizedSelected.slice(oldPrefix.length);
              const remappedSelected = `${newPrefix}${suffix}`;
              void openFile(remappedSelected, true);
            }

            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Renamed ${toVaultRelativePath(resolvedTargetPath)} to ${toVaultRelativePath(newPath)}.`
            }]);
          }
        } else if (proposedAction.type === 'delete_item') {
          if (!proposedAction.targetPath) {
            setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing target_path for delete action.' }]);
          } else {
            const resolvedTargetPath = resolveVaultExistingNodePath(proposedAction.targetPath, proposedAction.destinationPath);
            if (!resolvedTargetPath) {
              const noteSuggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
              const dirSuggestions = suggestVaultDirectoryPaths(proposedAction.targetPath, 4)
                .map(path => toVaultRelativePath(path));
              const combinedSuggestions = [...noteSuggestions, ...dirSuggestions].slice(0, 5);
              const suggestionText = combinedSuggestions.length ? ` Try one of: ${combinedSuggestions.join(', ')}` : '';
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Could not locate ${proposedAction.targetPath} for delete.${suggestionText}`
              }]);
              return;
            }

            const deleteResult = await window.nexusAPI.notes.delete(resolvedTargetPath);
            if (!deleteResult.success) {
              setVaultMessages(prev => [...prev, {
                sender: 'ai',
                text: `Delete failed: ${deleteResult.error || 'unknown error'}`
              }]);
              return;
            }

            const parentPath = getParentDirectory(resolvedTargetPath) || vaultPath;
            invalidateFileTreeCache(vaultPath);
            void loadFileTree(true);
            syncVaultSubtreeInBackground(parentPath);

            if (selectedFile && pathIsWithin(selectedFile, resolvedTargetPath)) {
              setSelectedFile(null);
              setSelectedTreePath(parentPath);
              setCreateTargetPath(parentPath);
              setFileContent('');
              setEditContent('');
              setIsEditing(false);
              localStorage.removeItem('brain_selectedFile');
            }

            setVaultMessages(prev => [...prev, {
              sender: 'ai',
              text: `Deleted ${toVaultRelativePath(resolvedTargetPath)}.`
            }]);
          }
        } else if (proposedAction.type === 'open_note') {
          if (!proposedAction.targetPath) {
            setVaultMessages(prev => [...prev, { sender: 'ai', text: 'Missing target path for open action.' }]);
          } else {
            const resolvedTargetPath = await resolveVaultTargetPath(proposedAction.targetPath, proposedAction.destinationPath);
            if (!resolvedTargetPath) {
              const openChoices = resolveVaultOpenChoicePaths(proposedAction.targetPath, proposedAction.destinationPath, 24);
              if (openChoices.length) {
                pushVaultOpenChoiceMessage(
                  openChoices,
                  `Could not locate an exact file for "${proposedAction.targetPath}". Pick one below:`
                );
              } else {
                const suggestions = suggestVaultNotePaths(proposedAction.targetPath, 4);
                const suggestionText = suggestions.length ? ` Try one of: ${suggestions.join(', ')}` : '';
                setVaultMessages(prev => [...prev, {
                  sender: 'ai',
                  text: `Could not locate ${proposedAction.targetPath} inside the current vault root.${suggestionText}`
                }]);
              }
            } else {
              setBrainScope('note');
              const opened = await openFile(resolvedTargetPath, true);
              if (opened) {
                setVaultMessages(prev => [...prev, {
                  sender: 'ai',
                  text: `Opened ${toVaultRelativePath(resolvedTargetPath)} in Note mode.`
                }]);
              } else {
                setVaultMessages(prev => [...prev, {
                  sender: 'ai',
                  text: `Found ${toVaultRelativePath(resolvedTargetPath)} but failed to open it.`
                }]);
              }
            }
          }
        } else {
          setVaultMessages(prev => [...prev, { sender: 'ai', text: `Unsupported vault action: ${proposedAction.type}` }]);
        }
      } catch (err) {
        console.error('Error applying vault AI action:', err);
        setVaultMessages(prev => [...prev, {
          sender: 'ai',
          text: `Vault action failed: ${getErrorMessage(err)}`
        }]);
      } finally {
        setProposedAction(null);
      }
      return;
    }
    if (proposedAction.sourceFile && selectedFile !== proposedAction.sourceFile) {
      setAiMessages(prev => [...prev, {
        sender: 'ai',
        text: 'Warning: This proposal was created for a different note and was not applied.'
      }]);
      setProposedAction(null);
      return;
    }

    try {
      if (proposedAction.type === 'create') {
        // ... existing create logic ...
        if (proposedAction.title) {
          const result = await window.nexusAPI.notes.createFile(selectedDirectoryPath, normalizeMarkdownFileName(proposedAction.title));
          if (result.success && result.path) {
            await window.nexusAPI.notes.writeFile(result.path, proposedAction.content || '');
            invalidateFileTreeCache(vaultPath);
            syncVaultSubtreeInBackground(result.path);
            void loadFileTree(true);
            void openFile(result.path, true);
            setAiMessages(prev => [...prev, { sender: 'ai', text: `Created new note: ${proposedAction.title}` }]);
          }
        }
      } else {
        // EDIT ACTIONS
        // We need to apply these changes to the File System AND the Editor state.

        let newContent = isEditing ? editContent : fileContent;
        const originalContent = newContent;

        let successMessage = 'Action applied.';

        console.log('[Nexus Apply] Action type:', proposedAction.type);
        console.log('[Nexus Apply] Target text:', proposedAction.target_text?.slice(0, 100));
        console.log('[Nexus Apply] Replacement content:', proposedAction.content?.slice(0, 100));
        console.log('[Nexus Apply] Range:', proposedAction.range);

        if (proposedAction.type === 'replace_all') {
          // Full file replacement
          const candidate = sanitizeProposedMarkdown(proposedAction.content || '', { aggressive: false }) || '';
          if (isUiTranscriptNoise(candidate)) {
            newContent = originalContent;
            successMessage = 'Blocked full rewrite: detected UI/chat transcript noise in proposed content.';
          } else {
            newContent = candidate;
            if (isEditing && editorRef.current) {
              (editorRef.current.commands as any).setContent(newContent, true);
            }
            successMessage = 'Entire note reformatted.';
          }
        }
        else if (proposedAction.type === 'replace_selection' && isEditing && editorRef.current && proposedAction.range && 'from' in proposedAction.range) {
          // Precise Tiptap replacement
          const range = proposedAction.range as { from: number, to: number };
          editorRef.current.commands.insertContentAt({ from: range.from, to: range.to }, proposedAction.content || '');
          newContent = editorRef.current.storage.markdown.getMarkdown();
          successMessage = 'Selection successfully replaced.';
        }
        else if (proposedAction.type === 'insert_at_cursor' && isEditing && editorRef.current && proposedAction.range && 'from' in proposedAction.range) {
          // Precise cursor insertion
          const range = proposedAction.range as { from: number, to: number }; // Insert at selection end or cursor
          editorRef.current.commands.insertContentAt({ from: range.to, to: range.to }, proposedAction.content || '');
          newContent = editorRef.current.storage.markdown.getMarkdown();
          successMessage = 'Content inserted at cursor.';
        }
        else if ((proposedAction.type === 'replace_selection' || proposedAction.type === 'find_and_replace') && proposedAction.target_text) {
          let targetFound = false;

          // Helper to normalize strings for comparison (removes extra whitespace/newlines)
          const normalize = (str: string) => str.replace(/\s+/g, ' ').trim();
          const targetNorm = normalize(proposedAction.target_text);

          // 1. Try exact string replacement first
          // We use standard string replace which only replaces the FIRST occurrence
          if (newContent.includes(proposedAction.target_text)) {
            newContent = newContent.replace(proposedAction.target_text, proposedAction.content || '');
            targetFound = true;
          }
          // 2. Try normalized replacement (slower but handles whitespace drift)
          else {
            const contentNorm = normalize(newContent);
            if (contentNorm.includes(targetNorm)) {
              // We found a fuzzy match. We need to do a regex replace that ignores whitespace
              const regexStr = proposedAction.target_text
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\s+/g, '\\s+');

              // DANGER: We DO NOT use 'g' flag here, otherwise it replaces every occurrence in the file!
              const fuzzyRegex = new RegExp(regexStr);
              if (fuzzyRegex.test(newContent)) {
                newContent = newContent.replace(fuzzyRegex, proposedAction.content || '');
                targetFound = true;
              }
            }
          }

          // 3. Last resort: use the user's ORIGINAL selection text (rendered text without markdown)
          // to fuzzy-match against the raw markdown file content
          const origSel = proposedAction.originalSelection;
          if (!targetFound && origSel && origSel !== proposedAction.target_text) {
            const fallbackRegexStr = origSel
              .split(/\s+/)
              .filter(Boolean)
              .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('[\\s\\S]*?'); // Allow any markdown characters between words

            // No 'g' flag - only replace the first match
            const desperateRegex = new RegExp(fallbackRegexStr);
            if (desperateRegex.test(newContent)) {
              newContent = newContent.replace(desperateRegex, proposedAction.content || '');
              targetFound = true;
            }
          }

          if (targetFound) {
            successMessage = 'Text updated successfully.';
          } else {
            // Do not append on failed replace; it causes repeated duplication.
            const targetLen = (proposedAction.target_text || '').trim().length;
            const contentLen = newContent.trim().length;
            const looksLikeLargeBlockReplace = contentLen > 0 && targetLen / contentLen >= 0.5;

            if (looksLikeLargeBlockReplace && proposedAction.content) {
              const fallbackCandidate = sanitizeProposedMarkdown(proposedAction.content, { aggressive: false }) || '';
              if (isUiTranscriptNoise(fallbackCandidate)) {
                newContent = originalContent;
                successMessage = 'Blocked fallback rewrite: detected UI/chat transcript noise in proposed content.';
              } else {
                newContent = fallbackCandidate;
                successMessage = 'Entire note reformatted (fallback due to massive selection).';
              }
            } else {
              successMessage = 'Warning: Could not find target text to replace. No changes were applied.';
            }
          }

          if (isEditing && editorRef.current) {
            (editorRef.current.commands as any).setContent(newContent, true);
          }
        }
        else if (proposedAction.type === 'insert_at_cursor') {
          // Fallback if we don't have exact cursor
          if (isEditing && editorRef.current) {
            editorRef.current.commands.insertContent(proposedAction.content);
            newContent = editorRef.current.storage.markdown.getMarkdown();
          } else {
            newContent = newContent.trim() + '\n\n' + (proposedAction.content || '').trim();
          }
          successMessage = 'Content inserted.';
        }
        else if (proposedAction.type === 'insert') {
          // Fallback append
          newContent = newContent.trim() + '\n\n' + (proposedAction.content || '').trim();
          if (isEditing && editorRef.current) {
            (editorRef.current.commands as any).setContent(newContent, true);
          }
          successMessage = 'Content appended.';
        }
        else if ((proposedAction.type === 'find_and_replace' || proposedAction.type === 'replace_selection') && proposedAction.content && !proposedAction.target_text) {
          // Missing target text: safer to no-op than overwrite/append unexpectedly.
          successMessage = 'Warning: Missing target text for replacement. No changes were applied.';
        }
        else {
          successMessage = 'Warning: Could not apply action - missing information.';
        }

        // Save to Disk
        if (selectedFile) {
          const success = await window.nexusAPI.notes.writeFile(selectedFile, newContent);

          if (success) {
            syncVaultSubtreeInBackground(selectedFile);
            setFileContent(newContent);
            setEditContent(newContent);
            setPreviousContent(newContent !== originalContent ? originalContent : null);
            setAiMessages(prev => [...prev, { sender: 'ai', text: successMessage }]);
          } else {
            setAiMessages(prev => [...prev, { sender: 'ai', text: 'Failed to save changes to file.' }]);
          }
        } else {
          console.error('[Nexus Apply] No selectedFile!');
        }
      }
    } catch (err) {
      console.error('Error applying AI action:', err);
    } finally {
      setProposedAction(null);
    }
  };

  // Handle Revert
  const handleRevertAction = async () => {
    if (!previousContent || !selectedFile || !window.nexusAPI?.notes) return;

    try {
      const success = await window.nexusAPI.notes.writeFile(selectedFile, previousContent);
      if (success) {
        syncVaultSubtreeInBackground(selectedFile);
        setFileContent(previousContent);
        setEditContent(previousContent);
        if (isEditing && editorRef.current) {
          (editorRef.current.commands as any).setContent(previousContent, true);
        }
        setAiMessages(prev => [...prev, { sender: 'ai', text: 'Action reverted.' }]);
        setPreviousContent(null);
      }
    } catch (err) {
      console.error('Failed to revert:', err);
    }
  };

  // Sidebar States
  const [isExplorerOpen, setIsExplorerOpen] = useState(true);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(true);

  return (
    <div className="flex h-full w-full bg-[#0a0a0a] text-white overflow-hidden rounded-xl border border-[#262626] animate-in fade-in duration-300 relative">

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
                {window.nexusAPI?.notes ? 'Loading...' : 'Run in Tauri desktop app to access files'}
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
          className={`w-1 hover:w-1.5 bg-[#262626] hover:bg-purple-500/50 cursor-col-resize z-50 transition-colors duration-150 ${isResizing ? 'bg-purple-500 w-1.5' : ''}`}
          style={{ touchAction: 'none' }}
        />
      )}

      {/* RIGHT COLUMN: NEXUS AI */}
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
                <span className="font-semibold text-sm tracking-wide text-gray-200">Nexus AI</span>
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
                <div className="absolute z-30 right-0 mt-2 w-[320px] max-w-[calc(100vw-3rem)] bg-[#151515] border border-[#333] rounded-lg shadow-xl overflow-hidden">
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
                    ) : (
                      availableModels
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
                              setShowModelDropdown(false);
                              setModelSearchQuery('');
                            }}
                            className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm hover:bg-[#262626] transition-colors ${selectedModel === model.id ? 'bg-purple-900/30 text-purple-300' : 'text-gray-300'}`}
                          >
                            {(aiProvider === 'lmstudio' || aiProvider === 'local')
                              ? <Cpu size={13} className="shrink-0 text-emerald-400/60" />
                              : <Cloud size={13} className="shrink-0 text-blue-400/60" />}
                            <span className="truncate">{model.name || model.id}</span>
                          </button>
                        ))
                    )}
                  </div>
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
              <div className="mb-2 flex items-center gap-2 rounded border border-[#2f2f2f] bg-[#101010] px-2 py-1.5 text-[11px] text-gray-300">
                <FileText size={11} className="text-cyan-400 shrink-0" />
                <span className="truncate">{selectedFile.split(/[/\\]/).pop()}</span>
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
              {currentMessages.map((msg, i) => (
                <ChatBubble
                  key={i}
                  sender={msg.sender}
                  text={msg.text}
                  context={msg.context}
                  isAction={msg.isAction}
                  options={msg.options}
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
                  isStreaming={i === streamingMsgIndex}
                  onStreamingDone={() => { if (i === streamingMsgIndex) setStreamingMsgIndex(null); }}
                />
              ))}
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
              : `Ask Nexus about ${selectedFile ? 'this note' : 'your notes'}...`}
          />
        </div>
      )}
    </div>
  );
};

const ChatInputBox: React.FC<{
  onSend: (message: string) => void;
  onStop: () => void;
  isLoading: boolean;
  showModeToggle?: boolean;
  mode?: 'lecture' | 'edit';
  onModeChange?: (mode: 'lecture' | 'edit') => void;
  placeholder: string;
}> = ({ onSend, onStop, isLoading, showModeToggle = false, mode = 'lecture', onModeChange, placeholder }) => {
  const [input, setInput] = useState('');
  const [isTextareaOverflowing, setIsTextareaOverflowing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const minHeight = showModeToggle ? 44 : 48;
    const maxHeight = 160;

    textarea.style.height = '0px';
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;

    const hasOverflow = textarea.scrollHeight > maxHeight;
    textarea.style.overflowY = hasOverflow ? 'auto' : 'hidden';
    setIsTextareaOverflowing(hasOverflow);
  }, [showModeToggle]);

  useEffect(() => {
    resizeTextarea();
  }, [input, placeholder, showModeToggle, resizeTextarea]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    onSend(input);
    setInput('');
  };

  return (
    <div className="p-4 bg-[#161616]">
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1 bg-[#0a0a0a] border border-[#262626] rounded-xl focus-within:border-purple-500/50 transition-colors">
          <div className={`flex items-start gap-2 ${showModeToggle ? 'px-2 py-2 pr-12' : ''}`}>
            {showModeToggle && (
              <div className="mt-1 shrink-0 flex p-0.5 bg-[#0a0a0a] rounded-lg border border-[#262626]">
                <button
                  onClick={() => onModeChange?.('lecture')}
                  className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${mode === 'lecture' ? 'bg-[#262626] text-purple-300' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  Lecture
                </button>
                <button
                  onClick={() => onModeChange?.('edit')}
                  className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${mode === 'edit' ? 'bg-[#262626] text-purple-300' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  Edit
                </button>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className={`w-full bg-transparent border-none text-sm text-gray-200 outline-none resize-none ${showModeToggle ? 'py-2 min-h-[44px]' : 'p-3 pr-12 min-h-[48px]'} ${isTextareaOverflowing ? 'overflow-y-auto custom-scrollbar' : 'overflow-y-hidden'}`}
            />
          </div>

          <button
            onClick={isLoading ? onStop : handleSend}
            disabled={!isLoading && !input.trim()}
            className={`absolute right-2 top-2 p-2 rounded-lg text-white transition-all shadow-lg shadow-purple-900/20 ${isLoading ? 'bg-red-500 hover:bg-red-600' : 'bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed'}`}
            title={isLoading ? "Stop generation" : "Send message"}
          >
            {isLoading ? <Square size={16} fill="currentColor" /> : <Send size={16} />}
          </button>
        </div>
      </div>
      <div className="mt-2 text-[10px] text-center text-gray-600">
        Nexus AI can make mistakes. Review generated actions.
      </div>
    </div>
  );
};


// Real File Tree Item Component
interface FileTreeItemRealProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string, isDirectory: boolean) => void;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  onDrop: (sourcePath: string, targetPath: string) => void;
  onRename: (oldPath: string, newName: string) => void;
}

const FileTreeItemReal: React.FC<FileTreeItemRealProps> = ({
  node, depth, selectedPath, onSelect, expandedFolders, toggleFolder, onDrop, onRename
}) => {
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = selectedPath === node.path;
  const [isDragOver, setIsDragOver] = useState(false);

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);

  // Drag Handlers
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('sourcePath', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (node.isDirectory) {
      setIsDragOver(true);
      e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const sourcePath = e.dataTransfer.getData('sourcePath');
    if (sourcePath && node.isDirectory) {
      onDrop(sourcePath, node.path);
    }
  };

  const submitRename = () => {
    const newName = renameValue.trim();
    if (newName && newName !== node.name) {
      onRename(node.path, newName);
    }
    setIsRenaming(false);
  };

  return (
    <div>
      <div
        draggable={!isRenaming}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDoubleClick={() => {
          if (!isRenaming && node.isDirectory) {
            toggleFolder(node.path);
          }
        }}
        onClick={() => {
          if (!isRenaming) {
            onSelect(node.path, node.isDirectory);
          }
        }}
        className={`
          flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none text-sm transition-colors group relative pr-8
          ${isSelected ? 'bg-[#262626] text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-[#262626]/50'}
          ${isDragOver ? 'bg-purple-900/30 ring-1 ring-purple-500' : ''}
        `}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (node.isDirectory) {
              toggleFolder(node.path);
            }
          }}
          className="opacity-70 group-hover:opacity-100 hover:text-white transition-colors"
          aria-label={node.isDirectory ? (isExpanded ? 'Collapse folder' : 'Expand folder') : 'File'}
        >
          {node.isDirectory ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span className="w-3.5" />
          )}
        </button>

        {node.isDirectory ? (
          isExpanded ? <FolderOpen size={14} className="text-yellow-500" /> : <Folder size={14} className="text-yellow-600" />
        ) : (
          <FileText size={14} className={isSelected ? 'text-cyan-400' : 'text-gray-400 group-hover:text-gray-200'} />
        )}

        {isRenaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') setIsRenaming(false);
            }}
            onBlur={submitRename}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-[#0a0a0a] border border-blue-500 rounded px-1 -ml-1 text-white outline-none"
          />
        ) : (
          <span className="truncate">{node.name.replace('.md', '')}</span>
        )}

        {/* Rename Button (Visible on Hover) */}
        {!isRenaming && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsRenaming(true);
              setRenameValue(node.name);
            }}
            className="absolute right-1 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-500 hover:text-white transition-all"
            title="Rename"
          >
            <Edit3 size={12} />
          </button>
        )}
      </div>

      {node.isDirectory && isExpanded && node.children && (
        <div className="flex flex-col gap-0.5">
          {node.children.map(child => (
            <FileTreeItemReal
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              onDrop={onDrop}
              onRename={onRename}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Markdown Renderer using react-markdown
interface MarkdownRendererProps {
  content: string;
  onCheckboxToggle?: (lineIndex: number, checked: boolean) => void;
}

const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({ content, onCheckboxToggle }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Headings
        h1: ({ children }) => <h1 className={MARKDOWN_STYLES.h1}>{children}</h1>,
        h2: ({ children }) => <h2 className={MARKDOWN_STYLES.h2}>{children}</h2>,
        h3: ({ children }) => <h3 className={MARKDOWN_STYLES.h3}>{children}</h3>,
        h4: ({ children }) => <h4 className={MARKDOWN_STYLES.h4}>{children}</h4>,
        h5: ({ children }) => <h5 className={MARKDOWN_STYLES.h5}>{children}</h5>,
        h6: ({ children }) => <h6 className={MARKDOWN_STYLES.h6}>{children}</h6>,

        // Paragraphs
        p: ({ children }) => <p className={MARKDOWN_STYLES.p}>{children}</p>,

        // Lists - detect if contains task items
        ul: ({ children, node, ...props }) => {
          // @ts-ignore
          const hasTaskItems = node?.children?.some((child: any) => typeof child?.checked === 'boolean');
          if (hasTaskItems) {
            return <ul className="list-none p-0 m-0" {...props}>{children}</ul>;
          }
          return <ul className={MARKDOWN_STYLES.ul} {...props}>{children}</ul>;
        },
        ol: ({ children }) => <ol className={MARKDOWN_STYLES.ol}>{children}</ol>,

        // List items with checkbox support  
        li: ({ children, node, ...props }) => {
          // @ts-ignore
          const isTaskItem = typeof node?.checked === 'boolean';

          if (isTaskItem) {
            // @ts-ignore
            const isChecked = node.checked;
            // @ts-ignore
            const lineNumber = node?.position?.start?.line ? node.position.start.line - 1 : -1;

            return (
              <li
                className="flex items-center gap-2 py-[2px] cursor-pointer list-none"
                onClick={() => {
                  if (onCheckboxToggle && lineNumber >= 0) {
                    onCheckboxToggle(lineNumber, !isChecked);
                  }
                }}
                {...props}
              >
                <span className={`
                  w-4 h-4 rounded-sm border flex-shrink-0 flex items-center justify-center
                  ${isChecked
                    ? 'bg-blue-500 border-blue-500'
                    : 'border-gray-500 bg-transparent hover:border-blue-400'
                  }
                `}>
                  {isChecked && (
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span className={`leading-tight [&>p]:m-0 [&>p]:inline ${isChecked ? 'line-through text-gray-500' : 'text-gray-300'}`}>
                  {children}
                </span>
              </li>
            );
          }

          return <li className={MARKDOWN_STYLES.li} {...props}>{children}</li>;
        },

        // Code
        code: ({ className, children, ...props }) => {
          const codeText = String(children).replace(/\n$/, '');
          const mermaidByClass = !!className && className.includes('language-mermaid');
          const mermaidByContent = looksLikeMermaid(codeText);
          const isMermaid = mermaidByClass || mermaidByContent;

          if (isMermaid) {
            return <MermaidBlock chart={codeText} />;
          }

          const isInline = !className;
          if (isInline) {
            return <code className={MARKDOWN_STYLES.codeInline}>{children}</code>;
          }
          return (
            <code className={`${className} text-gray-300`} {...props}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => {
          const child = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined;
          const className = child?.props?.className || '';
          const codeText = typeof child?.props?.children === 'string'
            ? child.props.children
            : Array.isArray(child?.props?.children)
              ? child?.props?.children.join('')
              : '';

          if (className.includes('language-mermaid') || looksLikeMermaid(codeText)) {
            return <MermaidBlock chart={codeText} />;
          }
          return (
            <pre className={MARKDOWN_STYLES.codeBlock}>
              {children}
            </pre>
          );
        },

        // Links
        a: ({ href, children }) => (
          <a href={href} className={MARKDOWN_STYLES.a} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),

        // Blockquotes
        blockquote: ({ children }) => (
          <blockquote className={MARKDOWN_STYLES.blockquote}>
            {children}
          </blockquote>
        ),

        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-4">
            <table className={MARKDOWN_STYLES.table}>{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-[#1a1a1a]">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className={MARKDOWN_STYLES.tr}>{children}</tr>,
        th: ({ children }) => <th className={MARKDOWN_STYLES.th}>{children}</th>,
        td: ({ children }) => <td className={MARKDOWN_STYLES.td}>{children}</td>,

        // Horizontal rule
        hr: () => <hr className={MARKDOWN_STYLES.hr} />,

        // Bold & Italic
        strong: ({ children }) => <strong className="font-bold text-white">{children}</strong>,
        em: ({ children }) => <em className="italic text-gray-400">{children}</em>,

        // Images
        img: ({ src, alt }) => (
          <img src={src} alt={alt || ''} className={MARKDOWN_STYLES.img} />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

const MarkdownRenderer = React.memo(MarkdownRendererImpl);
MarkdownRenderer.displayName = 'MarkdownRenderer';

const ChatBubbleImpl: React.FC<{
  sender: 'ai' | 'user';
  text: string;
  context?: string;
  isAction?: boolean;
  options?: BrainChatOption[];
  onOptionSelect?: (option: BrainChatOption) => void;
  allowFreeTextReply?: boolean;
  freeTextReplyPlaceholder?: string;
  onFreeTextReply?: (reply: string) => void;
  isStreaming?: boolean;
  onStreamingDone?: () => void;
}> = ({
  sender,
  text,
  context,
  isAction,
  options,
  onOptionSelect,
  allowFreeTextReply,
  freeTextReplyPlaceholder,
  onFreeTextReply,
  isStreaming = false,
  onStreamingDone,
}) => {
  const [isThinkExpanded, setIsThinkExpanded] = React.useState(false);
  const [freeTextReply, setFreeTextReply] = React.useState('');

  // Parse for <think> tags - handle attributes (e.g. <think reasoning>), both closed and unclosed blocks
  const thinkMatchClosed = text.match(/<think[^>]*>([\s\S]*?)<\/think>/i);
  const thinkMatchUnclosed = !thinkMatchClosed ? text.match(/<think[^>]*>([\s\S]*)/i) : null;
  let taggedThinking = thinkMatchClosed ? thinkMatchClosed[1] : (thinkMatchUnclosed ? thinkMatchUnclosed[1] : null);

  // If this message resulted in a successfully parsed action, we completely hide the raw text.
  // We still allow 'thinkContent' if DeepSeek or others generated thoughts before acting.
  if (isAction && sender === 'ai') {
    text = text?.trim() || 'Action proposed.';
  }

  // Remove <think> tags (both closed and unclosed, with optional attributes) and JSON action blocks
  let cleanText = text
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think[^>]*>[\s\S]*/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<nexus_action_json[^>]*>[\s\S]*$/ig, '')
    .replace(/<nexus_content[^>]*>[\s\S]*$/ig, '')
    .replace(/<\/?nexus_action_json[^>]*>/ig, '')
    .replace(/<\/?nexus_content[^>]*>/ig, '')
    .trim();

  // Hide all JSON blocks, even unclosed ones (common when Kimi runs out of tokens or forgets backticks)
  if (!isAction) {
    cleanText = cleanText.replace(/```json[\s\S]*?(?:```|$)/ig, '').trim();
    // Clean up loose JSON objects if the model just spat out `{ "action": ... }` at the end
    cleanText = cleanText.replace(/\{\s*"action"[\s\S]*?$/ig, '').trim();
  }

  // --- Heuristic chain-of-thought detection for models that don't use <think> tags ---
  // Detects leading paragraphs that look like internal reasoning and diverts them
  // into the collapsible "Thinking Process" dropdown.
  let heuristicThinking = '';
  if (sender === 'ai' && cleanText && !taggedThinking) {
    const paragraphReasoningPatterns = [
      /^(we|i) (have|found|see|can see|note|know|checked|searched|need|want|will|must|should)/i,
      /^the (evidence|data|result|ocr|activity|context|snippet|search|user|selected)/i,
      /^(looking|searching|checking|scanning|analyzing|reviewing|proceed)/i,
      /^provide (evidence|a bullet|the bullet|an answer)/i,
      /^also (note|remember|verify|check)/i,
      /^(so|therefore|thus),? (we|i|the answer|it|answer)/i,
      /^based on (the|this|our|that)/i,
      /^(it (seems|looks|appears)|this means|this indicates)/i,
      /^let('?s| me| us) /i,
      /^(this is|these are) (a |the )?(section|from|part|about|table|content|note|document)/i,
      /^proceed\.?$/i,
      /^(keep it|use plain|no json|no hallucin)/i,
      /^(explain|summarize|structure|format|answer)/i,
    ];

    const paragraphs = cleanText.split(/\n{2,}/);
    let stripUntil = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();
      // Stop if this is the last paragraph (always keep at least one)
      if (i >= paragraphs.length - 1) break;
      if (paragraphReasoningPatterns.some(p => p.test(para))) {
        stripUntil = i + 1;
      } else {
        break;
      }
    }
    if (stripUntil > 0) {
      heuristicThinking = paragraphs.slice(0, stripUntil).join('\n\n').trim();
      cleanText = paragraphs.slice(stripUntil).join('\n\n').trim();
    }
  }

  // Combine tagged and heuristic thinking
  const thinkContent = [taggedThinking, heuristicThinking].filter(Boolean).join('\n\n').trim() || null;
  const showThinkingOnlyState = sender === 'ai' && isStreaming && !cleanText && !!thinkContent;
  const containsHiddenActionMarkup = /<nexus_(?:action_json|content)[^>]*>?/i.test(text)
    || /```json/i.test(text)
    || /\{\s*"action"/i.test(text);
  const showActionPreparationState = sender === 'ai' && isStreaming && !cleanText && !thinkContent && containsHiddenActionMarkup;

  // If the model finished with only hidden control markup, keep the fallback specific
  // to actions instead of flashing a generic "Done." state.
  if (cleanText === '' && sender === 'ai' && !isStreaming && containsHiddenActionMarkup) {
    cleanText = 'Preparing action...';
  }

  // --- Animation for completed (non-streaming) messages only ---
  // During active streaming, tokens already arrive live via brain://token events.
  // Replaying them through the char animation just adds lag on top of real streaming.
  // After streaming is done (isStreaming goes false), show the full text immediately.

  // The displayed text:
  // - During streaming: show all received text immediately (token IS the animation)
  // - After streaming: show full cleanText
  const displayedText = cleanText;

  return (
    <div className={`flex flex-col ${sender === 'user' ? 'items-end' : 'items-start'} max-w-[95%]`}>

      {/* Context Badge for User Messages */}
      {sender === 'user' && context && (
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-purple-400 bg-purple-900/20 border border-purple-500/30 rounded px-2 py-1">
          <Sparkles size={10} />
          <span className="font-mono line-clamp-1 max-w-[200px]">{context}</span>
        </div>
      )}

      {/* Thinking Process (Collapsible) */}
      {thinkContent && (
        <div className="w-full mb-2">
          <button
            onClick={() => setIsThinkExpanded(!isThinkExpanded)}
            className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors mb-1"
          >
            <ChevronRight size={12} className={`transition-transform duration-200 ${isThinkExpanded ? 'rotate-90' : ''}`} />
            <span className="font-mono">Thinking Process</span>
          </button>

          {isThinkExpanded && (
            <div className="text-xs text-gray-400 bg-[#1a1a1a] border-l-2 border-gray-700 pl-3 py-2 my-1 italic font-mono whitespace-pre-wrap leading-relaxed animate-in slide-in-from-top-2 duration-200">
              {thinkContent.trim()}
            </div>
          )}
        </div>
      )}

      {/* Main Message */}
      <div className={`
        rounded-2xl px-4 py-3 text-sm leading-relaxed
        ${sender === 'user'
          ? 'bg-[#262626] text-gray-200 rounded-tr-sm border border-[#333] whitespace-pre-wrap'
          : 'bg-gradient-to-br from-purple-900/20 to-blue-900/10 text-gray-300 rounded-tl-sm border border-purple-500/10 chat-md-bubble'}
      `}>
        {sender === 'ai' ? (
          displayedText ? (
            <>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <h1 className="text-base font-bold text-white mt-3 mb-1.5">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-[15px] font-bold text-white mt-3 mb-1.5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-white mt-2.5 mb-1">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-medium text-gray-200 mt-2 mb-1">{children}</h4>,
                  h5: ({ children }) => <h5 className="text-sm font-medium text-gray-200 mt-1.5 mb-1">{children}</h5>,
                  h6: ({ children }) => <h6 className="text-sm font-medium text-gray-300 mt-1.5 mb-1">{children}</h6>,
                  p: ({ children }) => <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-5 text-sm my-1.5 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-5 text-sm my-1.5 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer" className="text-purple-300 underline hover:text-purple-200 transition-colors">
                      {children}
                    </a>
                  ),
                  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                  em: ({ children }) => <em className="italic text-gray-400">{children}</em>,
                  code: ({ className, children, ...props }) => {
                    const codeText = String(children).replace(/\n$/, '');
                    const mermaidByClass = !!className && className.includes('language-mermaid');
                    const mermaidByContent = looksLikeMermaid(codeText);
                    if (mermaidByClass || mermaidByContent) {
                      return <MermaidBlock chart={codeText} />;
                    }
                    const isBlock = !!className;
                    if (isBlock) {
                      return (
                        <code className="block text-xs text-gray-200 whitespace-pre-wrap" {...props as object}>
                          {children}
                        </code>
                      );
                    }
                    return (
                      <code className="px-1 py-0.5 rounded bg-[#1a1a1a] border border-[#333]/60 text-xs text-purple-300 font-mono" {...props as object}>
                        {children}
                      </code>
                    );
                  },
                  pre: ({ children }) => {
                    const child = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined;
                    const preClassName = child?.props?.className || '';
                    const preCodeText = typeof child?.props?.children === 'string'
                      ? child.props.children
                      : Array.isArray(child?.props?.children)
                        ? child?.props?.children.join('')
                        : '';
                    if (preClassName.includes('language-mermaid') || looksLikeMermaid(preCodeText)) {
                      return <MermaidBlock chart={preCodeText} />;
                    }
                    return (
                      <div className="relative my-2">
                        <pre className="text-xs bg-[#0d0d0d] border border-[#333]/70 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                          {children}
                        </pre>
                      </div>
                    );
                  },
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-2">
                      <table className="min-w-full text-xs border border-[#333] rounded overflow-hidden">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => <thead className="bg-[#1a1a1a]">{children}</thead>,
                  th: ({ children }) => <th className="px-2 py-1 text-left border-b border-[#333] font-semibold text-white">{children}</th>,
                  td: ({ children }) => <td className="px-2 py-1 align-top border-b border-[#262626] text-gray-300">{children}</td>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-purple-500/50 pl-3 italic text-gray-400 my-2">{children}</blockquote>
                  ),
                  hr: () => <hr className="border-[#333] my-3" />,
                }}
              >
                {displayedText}
              </ReactMarkdown>
              {(isStreaming && sender === 'ai') && (
                <span className="inline-block w-[5px] h-[14px] ml-0.5 align-[-2px] bg-purple-400/80 rounded-sm animate-pulse" />
              )}
            </>
          ) : (
            showActionPreparationState
              ? <span className="italic text-gray-500">Preparing action...</span>
              : showThinkingOnlyState
              ? <span className="italic text-gray-500">Thinking...</span>
                : thinkContent
                  ? null
                  : text
            )
          ) : (
            cleanText || (thinkContent ? null : text)
          )}
        </div>

      {sender === 'ai' && options?.length ? (
        <div className="mt-2 w-full flex flex-wrap gap-2">
          {options.map(option => (
            <button
              key={option.id}
              onClick={() => onOptionSelect?.(option)}
              disabled={!onOptionSelect}
              className="text-left px-3 py-2 rounded-lg border border-[#3a3a3a] bg-[#151515] hover:bg-[#1d1d1d] hover:border-purple-500/60 transition-colors max-w-[260px]"
              title={option.description || option.label}
            >
              <div className="text-xs text-purple-200 font-semibold truncate">{option.label}</div>
              {option.description ? (
                <div className="text-[10px] text-gray-500 truncate mt-0.5">{option.description}</div>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {sender === 'ai' && allowFreeTextReply && onFreeTextReply ? (
        <div className="mt-2 w-full max-w-[340px]">
          <div className="flex items-center gap-2 rounded-lg border border-[#333] bg-[#111] px-2 py-1.5">
            <input
              value={freeTextReply}
              onChange={(event) => setFreeTextReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  const answer = freeTextReply.trim();
                  if (!answer) return;
                  onFreeTextReply(answer);
                  setFreeTextReply('');
                }
              }}
              placeholder={freeTextReplyPlaceholder || 'Type your answer'}
              className="flex-1 bg-transparent border-none outline-none text-xs text-gray-200 placeholder:text-gray-500"
            />
            <button
              onClick={() => {
                const answer = freeTextReply.trim();
                if (!answer) return;
                onFreeTextReply(answer);
                setFreeTextReply('');
              }}
              className="px-2 py-1 rounded bg-purple-600/80 hover:bg-purple-500 text-[10px] text-white font-semibold transition-colors"
            >
              Reply
            </button>
          </div>
        </div>
      ) : null}

      <span className="text-[10px] text-gray-600 mt-1 px-1 select-none">
        {sender === 'ai' ? 'Nexus' : 'You'}
      </span>
    </div>
  );
};

const ChatBubble = React.memo(ChatBubbleImpl);
