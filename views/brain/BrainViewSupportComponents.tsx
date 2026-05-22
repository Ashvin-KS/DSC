import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { ChevronRight, ChevronDown, Folder, FileText, FolderOpen, Edit3, Square, Send, Sparkles } from 'lucide-react';
import { MermaidBlock } from '../../components/MermaidBlock';
import { BrainChatOption } from '../../services/brainAiService';
import { sanitizeAiVisibleText, VISUALIZE_INFO_RE } from '../../lib/aiText';
import { VisualizeBlock } from '../../components/VisualizeBlock';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

const MARKDOWN_STYLES = {
  h1: 'text-3xl font-bold text-white mt-6 mb-3',
  h2: 'text-2xl font-bold text-white mt-6 mb-3',
  h3: 'text-xl font-semibold text-white mt-4 mb-2',
  h4: 'text-lg font-semibold text-white mt-4 mb-2',
  h5: 'text-base font-semibold text-white mt-3 mb-1',
  h6: 'text-sm font-semibold text-gray-300 mt-3 mb-1',
  p: 'text-gray-300 my-2 leading-relaxed',
  ul: 'list-disc list-outside pl-5 text-gray-300 my-2 space-y-1',
  ol: 'list-decimal list-outside pl-5 text-gray-300 my-2 space-y-1',
  li: 'text-gray-300 leading-relaxed marker:text-gray-400 [&>p]:m-0 [&>p]:inline',
  codeInline: 'bg-[#262626] px-1.5 py-0.5 rounded text-purple-300 text-sm font-mono',
  codeBlock: 'bg-[#1a1a1a] p-4 rounded-lg overflow-x-auto text-sm my-3 border border-[#333] text-gray-300 font-mono',
  a: 'text-blue-400 hover:underline cursor-pointer',
  blockquote: 'border-l-4 border-purple-500 pl-4 text-gray-400 my-3 italic',
  hr: 'border-[#333] my-4',
  img: 'max-w-full rounded-lg my-3',
  table: 'w-full border-collapse text-sm my-3',
  th: 'text-left px-3 py-2 text-gray-200 font-semibold border-b border-[#333]',
  td: 'px-3 py-2 text-gray-300 border-b border-[#262626]',
  tr: 'hover:bg-[#1a1a1a]'
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

const ChatInputBox: React.FC<{
  onSend: (message: string) => void;
  onStop: () => void;
  isLoading: boolean;
  showModeToggle?: boolean;
  mode?: 'lecture' | 'edit' | 'mcq';
  onModeChange?: (mode: 'lecture' | 'edit' | 'mcq') => void;
  placeholder: string;
  pendingInput?: string | null;
  onPendingInputConsumed?: () => void;
}> = ({ onSend, onStop, isLoading, showModeToggle = false, mode = 'lecture', onModeChange, placeholder, pendingInput, onPendingInputConsumed }) => {
  const [input, setInput] = useState('');
  const [isTextareaOverflowing, setIsTextareaOverflowing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pendingInput !== undefined && pendingInput !== null) {
      setInput(pendingInput);
      onPendingInputConsumed?.();
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [pendingInput, onPendingInputConsumed]);

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
                <button
                  onClick={() => onModeChange?.('mcq')}
                  className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${mode === 'mcq' ? 'bg-[#262626] text-purple-300' : 'text-gray-500 hover:text-gray-300'}`}
                >
                  MCQ
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
        Atheletia AI can make mistakes. Review generated actions.
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
  onDrop: (sourcePath: string, targetPath: string) => void | Promise<unknown>;
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
    e.dataTransfer.setData('application/x-atheletia-path', node.path);
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.stopPropagation();
    if (node.isDirectory) {
      e.preventDefault();
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
    const sourcePath = e.dataTransfer.getData('application/x-atheletia-path')
      || e.dataTransfer.getData('sourcePath')
      || e.dataTransfer.getData('text/plain');
    if (sourcePath && node.isDirectory) {
      void Promise.resolve(onDrop(sourcePath, node.path)).catch((error) => {
        console.error('Brain file drop failed:', error);
      });
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
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
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
          const typedNode = node as any;
          const hasTaskItems = typedNode?.children?.some((child: any) => typeof child?.checked === 'boolean');
          if (hasTaskItems) {
            return <ul className="list-none p-0 m-0" {...props}>{children}</ul>;
          }
          return <ul className={MARKDOWN_STYLES.ul} {...props}>{children}</ul>;
        },
        ol: ({ children }) => <ol className={MARKDOWN_STYLES.ol}>{children}</ol>,

        // List items with checkbox support  
        li: ({ children, node, ...props }) => {
          const typedNode = node as any;
          const isTaskItem = typeof typedNode?.checked === 'boolean';

          if (isTaskItem) {
            const isChecked = typedNode.checked;
            const lineNumber = typedNode?.position?.start?.line ? typedNode.position.start.line - 1 : -1;

            return (
              <li
                className="flex items-start gap-2 py-[2px] cursor-pointer list-none"
                onClick={() => {
                  if (onCheckboxToggle && lineNumber >= 0) {
                    onCheckboxToggle(lineNumber, !isChecked);
                  }
                }}
                {...props}
              >
                <span className={`
                  mt-0.5 w-4 h-4 rounded-sm border flex-shrink-0 flex items-center justify-center
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
          const codeText = flattenReactNodeText(children).replace(/\n$/, '');
          const mermaidChart = extractMermaidChart(codeText, className);

          if (mermaidChart) {
            return <MermaidBlock chart={mermaidChart} />;
          }

          const isInline = !className && !codeText.includes('\n');
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
          const { className, codeText } = extractPreCodePayload(children);
          const mermaidChart = extractMermaidChart(codeText, className);

          if (mermaidChart) {
            return <MermaidBlock chart={mermaidChart} />;
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

  text = sender === 'ai' ? sanitizeAiVisibleText(text) : text;
  let taggedThinking = null;

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
    .replace(/<atheletia_action_json[^>]*>[\s\S]*$/ig, '')
    .replace(/<atheletia_content[^>]*>[\s\S]*$/ig, '')
    .replace(/<\/?atheletia_action_json[^>]*>/ig, '')
    .replace(/<\/?atheletia_content[^>]*>/ig, '')
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

  // Hidden model reasoning is intentionally never rendered.
  const thinkContent = null;
  const showThinkingOnlyState = sender === 'ai' && isStreaming && !cleanText && !!thinkContent;
  const containsHiddenActionMarkup = /<atheletia_(?:action_json|content)[^>]*>?/i.test(text)
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

      {/* Hidden model reasoning is intentionally not rendered. */}
      {false && thinkContent && (
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
        rounded-2xl px-4 py-3 text-sm leading-relaxed overflow-x-auto break-words
        ${sender === 'user'
          ? 'bg-[#262626] text-gray-200 rounded-tr-sm border border-[#333] whitespace-pre-wrap'
          : 'bg-gradient-to-br from-purple-900/20 to-blue-900/10 text-gray-300 rounded-tl-sm border border-purple-500/10 chat-md-bubble'}
      `}>
        {sender === 'ai' ? (
          displayedText ? (
            <>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  h1: ({ children }) => <h1 className="text-base font-bold text-white mt-3 mb-1.5">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-[15px] font-bold text-white mt-3 mb-1.5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-white mt-2.5 mb-1">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-medium text-gray-200 mt-2 mb-1">{children}</h4>,
                  h5: ({ children }) => <h5 className="text-sm font-medium text-gray-200 mt-1.5 mb-1">{children}</h5>,
                  h6: ({ children }) => <h6 className="text-sm font-medium text-gray-300 mt-1.5 mb-1">{children}</h6>,
                  p: ({ children }) => <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>,
                  ul: ({ children, node, ...props }) => {
                    const typedNode = node as any;
                    const hasTaskItems = typedNode?.children?.some((child: any) => typeof child?.checked === 'boolean');
                    if (hasTaskItems) {
                      return <ul className="list-none pl-0 my-1.5 space-y-1" {...props}>{children}</ul>;
                    }
                    return <ul className="list-disc list-outside pl-5 text-sm my-1.5 space-y-0.5" {...props}>{children}</ul>;
                  },
                  ol: ({ children }) => <ol className="list-decimal list-outside pl-5 text-sm my-1.5 space-y-0.5">{children}</ol>,
                  li: ({ children, node, ...props }) => {
                    const typedNode = node as any;
                    const isTaskItem = typeof typedNode?.checked === 'boolean';
                    if (isTaskItem) {
                      const isChecked = !!typedNode?.checked;
                      return (
                        <li className="flex items-start gap-2 leading-relaxed list-none" {...props}>
                          <span className={`mt-0.5 w-4 h-4 rounded-sm border flex-shrink-0 flex items-center justify-center ${isChecked ? 'bg-purple-500/90 border-purple-500/90' : 'border-gray-500 bg-transparent'}`}>
                            {isChecked ? (
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            ) : null}
                          </span>
                          <span className={`[&>p]:m-0 [&>p]:inline ${isChecked ? 'line-through text-gray-500' : 'text-gray-300'}`}>
                            {children}
                          </span>
                        </li>
                      );
                    }
                    return <li className="leading-relaxed marker:text-gray-500 [&>p]:m-0 [&>p]:inline" {...props}>{children}</li>;
                  },
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer" className="text-purple-300 underline hover:text-purple-200 transition-colors">
                      {children}
                    </a>
                  ),
                  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                  em: ({ children }) => <em className="italic text-gray-400">{children}</em>,
                  code: ({ className, children, ...props }) => {
                    const codeText = flattenReactNodeText(children).replace(/\n$/, '');
                    const lang = className?.replace('language-', '') || '';
                    if (VISUALIZE_INFO_RE.test(lang) || lang === 'visualize-html') {
                      return <VisualizeBlock html={codeText} />;
                    }
                    const mermaidChart = extractMermaidChart(codeText, className);
                    if (mermaidChart) {
                      return <MermaidBlock chart={mermaidChart} />;
                    }
                    const isBlock = !!className || codeText.includes('\n');
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
                    const { className: preClassName, codeText: preCodeText } = extractPreCodePayload(children);
                    const lang = preClassName?.replace('language-', '') || '';
                    if (VISUALIZE_INFO_RE.test(lang) || lang === 'visualize-html') {
                      return <VisualizeBlock html={preCodeText} />;
                    }
                    const mermaidChart = extractMermaidChart(preCodeText, preClassName);
                    if (mermaidChart) {
                      return <MermaidBlock chart={mermaidChart} />;
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
                {displayedText.replace(/```html[ \t]+visualize/gi, '```visualize-html')}
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
        {sender === 'ai' ? 'Atheletia' : 'You'}
      </span>
    </div>
  );
};

const ChatBubble = React.memo(ChatBubbleImpl);

export { ChatInputBox, FileTreeItemReal, MarkdownRenderer, ChatBubble };
