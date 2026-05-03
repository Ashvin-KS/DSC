import React, { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { Heading1, Heading2, Bold, Italic, List, ListOrdered, CheckSquare, Quote } from 'lucide-react';
import { BrainChatOption, ParsedActionPayload } from '../../services/brainAiService';

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

interface VaultMultiFileChainState {
  baseTask: string;
  destinationPath: string;
  createdPaths: string[];
}

interface MultiFileInstruction {
  title: string | null;
  content: string | null;
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
      .replace(/<atheletia_action_json>[\s\S]*?<\/atheletia_action_json>/ig, '')
      .replace(/<atheletia_content>[\s\S]*?<\/atheletia_content>/ig, '')
      .replace(/```(?:json)?\s*(?:\{[\s\S]*?"action"[\s\S]*?\})\s*```/ig, '')
      .replace(/<atheletia_action_json>[\s\S]*$/ig, '') // Unclosed tags at the end
      .replace(/<atheletia_content>[\s\S]*$/ig, '') // Unclosed tags at the end
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
      if (children.length === 0 && (node.children || []).length > 0) return null;
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
  /\b(open|show|list)\b.*\b(all|every)\b.*\b(files|notes|docs|documents)\b|\b(all|every)\b.*\b(files|notes|docs|documents)\b.*\b(open|show|list)\b/i.test(input);

const isVaultInventoryIntent = (input: string): boolean =>
  /\b(what|which|show|list)\b.*\b(vault|folder|notes?)\b.*\b(contain|contains|inside|have|has)\b|\b(contents?|structure)\b.*\b(vault|folder)\b|\bwhat\s+all\b.*\b(vault|folder|notes?)\b/i.test(input);

const isMultiFileVaultIntent = (input: string): boolean => {
  const text = (input || '').toLowerCase();
  return /\b(multiple|many|several|few)\b[\s\S]*\b(files?|notes?|documents?|letters?)\b/i.test(text)
    || /\b(files?|notes?)\b[\s\S]*\b(one\s+by\s+one|one-by-one|each\s+one|one\s+at\s+a\s+time)\b/i.test(text)
    || /\bcreate\b[\s\S]*\b(files?|notes?)\b[\s\S]*\b(one\s+by\s+one|each)\b/i.test(text);
};

const isMultiFileChainDoneSignal = (input: string): boolean =>
  /^\s*(done|finish|finished|stop|complete|that's all|thats all|no more)\s*$/i.test(input);

const extractVaultDestinationHint = (input: string): string | null => {
  const text = (input || '').trim();
  if (!text) return null;

  const patterns = [
    /(?:in|inside|under)\s+(?:the\s+)?(?:folder\s+)?"([^"]+)"/i,
    /(?:in|inside|under)\s+(?:the\s+)?(?:folder\s+)?'([^']+)'/i,
    /(?:in|inside|under)\s+(?:the\s+)?(?:folder\s+)?([^,.!?\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const cleaned = match[1]
      .replace(/^the\s+/i, '')
      .replace(/^folder\s+/i, '')
      .trim();
    if (cleaned) return cleaned;
  }

  return null;
};

const requestsCreateAndWriteInVault = (input: string): boolean => {
  const text = (input || '').toLowerCase();
  const asksToCreateFile = /\b(create|make)\b[\s\S]*\b(file|note|letter|document|markdown)\b|\b(file|note)\b[\s\S]*\b(called|named)\b/i.test(text);
  const asksToWriteBody = /\b(write|draft|compose|content|text|letter)\b/i.test(text);
  return asksToCreateFile && asksToWriteBody;
};

const extractRequestedNoteTitle = (input: string): string | null => {
  const text = (input || '').trim();
  if (!text) return null;

  const patterns = [
    /(?:file|note|letter|document)\s+(?:called|named)\s+"([^"]+)"/i,
    /(?:file|note|letter|document)\s+(?:called|named)\s+'([^']+)'/i,
    /(?:file|note|letter|document)\s+(?:called|named)\s+([^,.!?\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const candidate = match[1].trim().replace(/[?!.]+$/g, '');
    if (!candidate) continue;
    return normalizeMarkdownFileName(candidate);
  }

  if (/\blove\s+letter\b/i.test(text)) {
    return normalizeMarkdownFileName('Love Letter');
  }

  return null;
};

const parseMultiFileInstruction = (input: string): MultiFileInstruction => {
  const text = (input || '').trim();
  if (!text) {
    return { title: null, content: null };
  }

  const pairMatch = text.match(/^(?:"([^"]+)"|'([^']+)'|([^:\n]+?))\s*::\s*([\s\S]+)$/);
  if (pairMatch) {
    const rawTitle = (pairMatch[1] || pairMatch[2] || pairMatch[3] || '').trim();
    const rawContent = (pairMatch[4] || '').trim();
    return {
      title: rawTitle ? normalizeMarkdownFileName(rawTitle) : null,
      content: rawContent || null,
    };
  }

  let title = extractRequestedNoteTitle(text);
  if (!title) {
    const quoted = text.match(/"([^"]+)"|'([^']+)'/);
    const quotedValue = (quoted?.[1] || quoted?.[2] || '').trim();
    if (quotedValue) {
      title = normalizeMarkdownFileName(quotedValue);
    }
  }

  if (!title) {
    const cleaned = text
      .replace(/^(create|make|add)\s+(?:another\s+|next\s+|new\s+)?(?:file|note|document|letter)\s*/i, '')
      .replace(/^(file|note|document|letter)\s*/i, '')
      .replace(/\b(with|write|content|text|body)\b[\s\S]*$/i, '')
      .replace(/\b(in|inside|under)\b[\s\S]*$/i, '')
      .replace(/[?!.]+$/g, '')
      .trim();
    if (cleaned && cleaned.length <= 90) {
      title = normalizeMarkdownFileName(cleaned);
    }
  }

  let content: string | null = null;
  const explicitContent = text.match(/(?:with\s+content|write|content|text|body)\s*[:\-]?\s*([\s\S]+)/i);
  if (explicitContent?.[1]) {
    content = explicitContent[1].trim() || null;
  }

  if (!content) {
    const lines = text.split('\n').map(line => line.trim());
    if (lines.length > 1) {
      content = lines.slice(1).join('\n').trim() || null;
    }
  }

  return { title, content };
};

const buildMultiFileStarterMarkdown = (fileName: string): string => {
  const heading = fileName.replace(/\.md$/i, '').trim() || 'Untitled';
  return `# ${heading}\n\n`;
};

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
  ul: "list-disc list-outside pl-5 text-gray-300 my-2 space-y-1",
  ol: "list-decimal list-outside pl-5 text-gray-300 my-2 space-y-1",
  li: "text-gray-300 leading-relaxed marker:text-gray-400 [&>p]:m-0 [&>p]:inline",
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

const flattenReactNodeText = (input: React.ReactNode): string => {
  if (input === null || input === undefined || typeof input === 'boolean') return '';
  if (typeof input === 'string' || typeof input === 'number') return String(input);
  if (Array.isArray(input)) return input.map(flattenReactNodeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(input)) {
    return flattenReactNodeText(input.props.children);
  }
  return '';
};

const normalizeMermaidChart = (input: string): string => {
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
};

const firstMermaidDirectiveLine = (input: string): string => {
  const normalized = normalizeMermaidChart(input);
  if (!normalized) return '';

  const lines = normalized.split('\n').map(line => line.trim());
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('%%')) continue;
    return line;
  }

  return '';
};

const looksLikeMermaid = (input: string): boolean => {
  const firstLine = firstMermaidDirectiveLine(input);
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|architecture|block-beta)\b/i.test(firstLine);
};

const extractMermaidChart = (codeText: string, className?: string): string | null => {
  const normalized = normalizeMermaidChart(codeText);
  if (!normalized) return null;

  if (className?.includes('language-mermaid') || looksLikeMermaid(normalized)) {
    return normalized;
  }

  return null;
};

const extractPreCodePayload = (children: React.ReactNode): { className: string; codeText: string } => {
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
            class: (node: { level: number }) => MARKDOWN_STYLES[`h${node.level}` as keyof typeof MARKDOWN_STYLES] || '',
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


export type {
  BrainScope,
  FileNode,
  VaultSearchHit,
  VaultSearchResult,
  VaultIndexProgress,
  VaultPathResolution,
  VaultResolveConfidence,
  VaultMultiFileChainState,
  MultiFileInstruction,
};

export {
  DEFAULT_VAULT,
  BRAIN_LAST_MODEL_STORAGE_KEY,
  DEFAULT_NIM_MODEL,
  DEFAULT_BRAIN_SCOPE,
  dedupeEquivalentPaths,
  extractMarkdownHeadingTitles,
  normalizeMarkdownFileName,
  findNodeByPath,
  getParentDirectory,
  getDirectoryForNodePath,
  normalizePathForComparison,
  areEquivalentPaths,
  pathIsWithin,
  stripWindowsExtendedPathPrefix,
  isAbsoluteFilePath,
  joinFileSystemPath,
  escapeRegExp,
  collectDirectoryPaths,
  collectMarkdownPaths,
  getErrorMessage,
  sanitizeVisibleBrainResponse,
  isMarkdownPath,
  filterMarkdownTree,
  normalizeClarificationOptions,
  isExplicitWholeRewriteIntent,
  hasOperationIntent,
  hasSpecificEditTarget,
  isAmbiguousOperationRequest,
  looksLikeClarificationQuestion,
  isVaultPathActionIntent,
  isBulkVaultOpenIntent,
  isVaultInventoryIntent,
  isMultiFileVaultIntent,
  isMultiFileChainDoneSignal,
  extractVaultDestinationHint,
  requestsCreateAndWriteInVault,
  extractRequestedNoteTitle,
  parseMultiFileInstruction,
  buildMultiFileStarterMarkdown,
  buildBrainActionPreview,
  MARKDOWN_STYLES,
  flattenReactNodeText,
  normalizeMermaidChart,
  firstMermaidDirectiveLine,
  looksLikeMermaid,
  extractMermaidChart,
  extractPreCodePayload,
  TiptapEditor,
};
