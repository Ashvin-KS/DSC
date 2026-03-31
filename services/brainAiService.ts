export type BrainActionType =
  | 'insert_content'
  | 'create_note'
  | 'edit_note'
  | 'create_folder'
  | 'move_note'
  | 'open_note'
  | 'rename_note'
  | 'delete_item'
  | 'ask_question'
  | 'replace_selection'
  | 'insert_at_cursor'
  | 'find_and_replace'
  | 'replace_all';

export interface ParsedQuestionOption {
  label?: string;
  value?: string;
  description?: string;
}

export interface ParsedActionPayload {
  action?: BrainActionType;
  content?: string;
  explanation?: string;
  target_text?: string;
  title?: string;
  target_path?: string;
  source_path?: string;
  destination_path?: string;
  new_name?: string;
  question?: string;
  question_id?: string;
  options?: Array<string | ParsedQuestionOption>;
  allow_free_text?: boolean;
  free_text_placeholder?: string;
}

export type BrainChatOptionAction = 'open_note' | 'list_folder' | 'answer_question';

export interface BrainChatOption {
  id: string;
  label: string;
  value: string;
  description?: string;
  action: BrainChatOptionAction;
  questionId?: string;
}

export interface BrainChatMessage {
  sender: 'ai' | 'user';
  text: string;
  context?: string;
  isAction?: boolean;
  options?: BrainChatOption[];
  questionPrompt?: string;
  questionId?: string;
  allowFreeTextReply?: boolean;
  freeTextReplyPlaceholder?: string;
}

interface LineRecord {
  line: number;
  text: string;
}

interface RagChunk {
  id: number;
  startLine: number;
  endLine: number;
  text: string;
}

interface LocalToolExecution {
  tool: string;
  reason: string;
  output: string;
}

interface SanitizeOptions {
  aggressive?: boolean;
}

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'with', 'from', 'this', 'your', 'have', 'will', 'into',
  'about', 'please', 'make', 'just', 'need', 'what', 'when', 'where', 'which',
  'for', 'are', 'was', 'were', 'has', 'had', 'you', 'its', 'their', 'them'
]);

const toLineRecords = (content: string): LineRecord[] =>
  content.split(/\r?\n/).map((text, idx) => ({ line: idx + 1, text }));

const extractLineWindow = (content: string, startLine: number, endLine: number, pad = 3): string => {
  const lines = content.split(/\r?\n/);
  const s = Math.max(1, startLine - pad);
  const e = Math.min(lines.length, endLine + pad);
  return lines
    .slice(s - 1, e)
    .map((line, i) => `${s + i}| ${line}`)
    .join('\n');
};

const buildHeadingOutline = (content: string, limit = 40): string => {
  const lines = toLineRecords(content);
  const headings = lines
    .filter(l => /^#{1,6}\s+/.test(l.text))
    .slice(0, limit)
    .map(l => `${l.line}| ${l.text}`);
  return headings.length ? headings.join('\n') : 'No markdown headings found.';
};

const getQueryTerms = (query: string): string[] => {
  const unique = new Set(
    query
      .toLowerCase()
      .match(/[a-z0-9_]{3,}/g) || []
  );
  return [...unique].filter(t => !STOP_WORDS.has(t)).slice(0, 12);
};

const keywordLineSearch = (content: string, query: string, maxHits = 10): string => {
  const terms = getQueryTerms(query);
  if (!terms.length) return 'No useful keywords extracted from query.';
  const lines = toLineRecords(content);
  const hits: string[] = [];
  for (const line of lines) {
    const lower = line.text.toLowerCase();
    if (terms.some(t => lower.includes(t))) {
      hits.push(`${line.line}| ${line.text}`);
      if (hits.length >= maxHits) break;
    }
  }
  return hits.length ? hits.join('\n') : `No keyword hits for: ${terms.join(', ')}`;
};

const buildRagChunks = (content: string, linesPerChunk = 30, overlap = 8): RagChunk[] => {
  const lines = content.split(/\r?\n/);
  if (!lines.length) return [];
  const chunks: RagChunk[] = [];
  let start = 0;
  let id = 1;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + linesPerChunk);
    chunks.push({
      id,
      startLine: start + 1,
      endLine: end,
      text: lines.slice(start, end).join('\n')
    });
    if (end === lines.length) break;
    start = Math.max(start + linesPerChunk - overlap, start + 1);
    id += 1;
  }
  return chunks;
};

const scoreRagChunk = (chunk: RagChunk, queryTerms: string[], selectedText?: string): number => {
  const hay = chunk.text.toLowerCase();
  let score = 0;
  for (const t of queryTerms) {
    if (hay.includes(t)) score += 2;
  }
  if (selectedText) {
    const sTerms = getQueryTerms(selectedText);
    for (const t of sTerms) {
      if (hay.includes(t)) score += 1;
    }
  }
  score += Math.max(0, 0.25 - chunk.id * 0.01);
  return score;
};

const retrieveRagContext = (content: string, query: string, selectedText?: string, topK = 4): string => {
  const chunks = buildRagChunks(content);
  const queryTerms = getQueryTerms(query);
  const ranked = chunks
    .map(c => ({ chunk: c, score: scoreRagChunk(c, queryTerms, selectedText) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(x => x.score > 0);

  if (!ranked.length) return 'No high-confidence RAG chunks.';
  return ranked
    .map(x => `Chunk ${x.chunk.id} [${x.chunk.startLine}-${x.chunk.endLine}]\n${x.chunk.text}`)
    .join('\n\n---\n\n');
};

export const runLocalAgenticTools = (params: {
  content: string;
  userMessage: string;
  selectedText?: string;
  selectedRange?: { startLine: number; endLine: number } | null;
}): LocalToolExecution[] => {
  const runs: LocalToolExecution[] = [];

  runs.push({
    tool: 'outline_scan',
    reason: 'Find structure anchors and section boundaries.',
    output: buildHeadingOutline(params.content)
  });

  if (params.selectedRange) {
    runs.push({
      tool: 'extract_lines',
      reason: 'Get exact line window around user selection for precise edits.',
      output: extractLineWindow(params.content, params.selectedRange.startLine, params.selectedRange.endLine, 4)
    });
  }

  runs.push({
    tool: 'keyword_search',
    reason: 'Locate likely edit targets by query terms.',
    output: keywordLineSearch(params.content, `${params.userMessage}\n${params.selectedText || ''}`)
  });

  runs.push({
    tool: 'rag_retrieve',
    reason: 'Retrieve semantically relevant chunks for planning and rewriting.',
    output: retrieveRagContext(params.content, params.userMessage, params.selectedText)
  });

  return runs;
};

export const serializeToolRuns = (runs: LocalToolExecution[]): string =>
  runs
    .map((r, i) => `TOOL ${i + 1}: ${r.tool}\nReason: ${r.reason}\nOutput:\n${r.output}`)
    .join('\n\n====================\n\n');

export const isUiTranscriptNoise = (text: string): boolean => {
  const t = text || '';
  const patterns = [
    /dashboard\s*\n\s*chat\s*\n\s*activity/i,
    /nexus ai can make mistakes/i,
    /ask nexus about this note/i,
    /action proposed\./i,
    /action reverted\./i,
    /change vault/i,
    /undo ai edit/i
  ];
  return patterns.some(p => p.test(t));
};

const sanitizeMessageForModel = (text: string): string => {
  const compact = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return compact.length > 1800 ? `${compact.slice(0, 1800)}\n...(truncated)...` : compact;
};

const normalizeComparable = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[`*_>#~\-]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeMarkdownLayout = (input: string): string => {
  let s = input.replace(/\r\n/g, '\n').trim();

  // Ensure fenced code blocks are on their own lines.
  s = s.replace(/([^\n])(```[a-zA-Z0-9_-]*\s*)/g, '$1\n$2');
  s = s.replace(/([^\n])(```)(?![a-zA-Z0-9_-])/g, '$1\n$2');
  s = s.replace(/(```)(?![a-zA-Z0-9_-])([^\n])/g, '$1\n$2');

  // Ensure heading has a space after hashes and starts on its own line.
  s = s.replace(/([^\n])(#{1,6}\s*)/g, '$1\n$2');
  s = s.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');

  // Add spacing around headings and code fences for stable markdown parsing.
  s = s.replace(/\n(#{1,6}\s)/g, '\n\n$1');
  s = s.replace(/\n(```[a-zA-Z0-9_-]*\n)/g, '\n\n$1');
  s = s.replace(/(```)\n(?!\n)/g, '$1\n');

  // Normalize excessive blank lines while keeping paragraph structure.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
};

const sanitizeNonCodeMarkdownSegment = (segment: string): string => {
  const blocks = segment.split(/\n{2,}/);
  const seenBlocks = new Set<string>();
  const dedupedBlocks: string[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trimEnd();
    const key = normalizeComparable(block);
    if (!key) continue;

    if (key.length >= 24) {
      if (seenBlocks.has(key)) continue;
      seenBlocks.add(key);
    }

    dedupedBlocks.push(block);
  }

  const lines = dedupedBlocks.join('\n\n').split('\n');
  const seenStepLines = new Set<string>();
  const seenStepNumbers = new Set<number>();
  const finalLines: string[] = [];

  for (const line of lines) {
    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numberVal = numbered ? Number(numbered[1]) : null;
    const item = numbered?.[2] || bullet?.[1];

    if (item) {
      const key = normalizeComparable(item);
      const looksAlgoLike = /(for each|update|compute|return|store|loop|scan|hash map|remainder|total)/i.test(item);

      if (key.length >= 14 && seenStepLines.has(key)) {
        continue;
      }
      if (numberVal !== null && looksAlgoLike && seenStepNumbers.has(numberVal)) {
        continue;
      }

      if (key.length >= 14) seenStepLines.add(key);
      if (numberVal !== null && looksAlgoLike) seenStepNumbers.add(numberVal);
    }

    finalLines.push(line);
  }

  return finalLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

export const sanitizeProposedMarkdown = (content?: string, options: SanitizeOptions = {}): string | undefined => {
  if (content === undefined) return undefined;
  const normalized = normalizeMarkdownLayout(content);
  if (!normalized) return normalized;

  const segments = normalized.split(/(```[\s\S]*?```)/g);
  const aggressive = options.aggressive ?? true;
  const cleaned = segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg;
      return aggressive ? sanitizeNonCodeMarkdownSegment(seg) : seg.trim();
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n');

  return normalizeMarkdownLayout(cleaned);
};

export const buildModelConversation = (messages: BrainChatMessage[], aiMode: 'lecture' | 'edit') => {
  const filtered = messages.filter(m => {
    if (!m.text || !m.text.trim()) return false;
    if (m.isAction) return false;
    if (isUiTranscriptNoise(m.text)) return false;
    return true;
  });

  const reversed = [...filtered].reverse();
  const selected: BrainChatMessage[] = [];
  let userCount = 0;
  let aiCount = 0;
  const maxUser = aiMode === 'edit' ? 4 : 6;
  const maxAi = aiMode === 'edit' ? 2 : 4;

  for (const msg of reversed) {
    if (msg.sender === 'user' && userCount < maxUser) {
      selected.push(msg);
      userCount += 1;
      continue;
    }
    if (msg.sender === 'ai' && aiCount < maxAi) {
      selected.push(msg);
      aiCount += 1;
    }
    if (userCount >= maxUser && aiCount >= maxAi) break;
  }

  return selected
    .reverse()
    .map(m => ({
      role: m.sender === 'ai' ? 'assistant' : 'user',
      content: sanitizeMessageForModel(m.text)
    }));
};

const repairJson = (raw: string): string => {
  const s = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch === '\n') {
      result += '\\n';
      continue;
    }
    if (inString && ch === '\t') {
      result += '\\t';
      continue;
    }
    if (inString && ch === '\r') continue;
    result += ch;
  }
  return result;
};

const manualExtractAction = (raw: string): ParsedActionPayload | null => {
  try {
    const out: ParsedActionPayload = {};
    const extractField = (key: string) => {
      const needle = `"${key}"`;
      let idx = raw.indexOf(needle);
      if (idx === -1) return undefined;
      const colon = raw.indexOf(':', idx);
      if (colon === -1) return undefined;
      const start = raw.indexOf('"', colon + 1);
      if (start === -1) return undefined;
      let i = start + 1;
      let escaped = false;
      while (i < raw.length) {
        const ch = raw[i];
        if (escaped) {
          escaped = false;
          i += 1;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          i += 1;
          continue;
        }
        if (ch === '"') break;
        i += 1;
      }
      if (i >= raw.length) return undefined;
      return raw.slice(start + 1, i).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    };
    out.action = extractField('action') as BrainActionType | undefined;
    out.content = extractField('content');
    out.explanation = extractField('explanation');
    out.target_text = extractField('target_text');
    out.title = extractField('title');
    out.target_path = extractField('target_path');
    out.source_path = extractField('source_path');
    out.destination_path = extractField('destination_path');
    out.new_name = extractField('new_name');
    out.question = extractField('question');
    out.question_id = extractField('question_id');
    out.free_text_placeholder = extractField('free_text_placeholder');

    const booleanMatch = raw.match(/"allow_free_text"\s*:\s*(true|false)/i);
    if (booleanMatch) {
      out.allow_free_text = booleanMatch[1].toLowerCase() === 'true';
    }

    const optionsMatch = raw.match(/"options"\s*:\s*(\[[\s\S]*?\])/i);
    if (optionsMatch?.[1]) {
      try {
        const parsedOptions = JSON.parse(repairJson(optionsMatch[1]));
        if (Array.isArray(parsedOptions)) {
          out.options = parsedOptions as Array<string | ParsedQuestionOption>;
        }
      } catch {
        // Ignore malformed options arrays in fallback mode.
      }
    }

    return out.action ? out : null;
  } catch {
    return null;
  }
};

const parseCandidateJson = (candidate: string): ParsedActionPayload | null => {
  try {
    return JSON.parse(repairJson(candidate)) as ParsedActionPayload;
  } catch {
    return manualExtractAction(candidate);
  }
};

const extractTaggedBlock = (text: string, tag: string): string | null => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() || null;
};

export const parseActionPayload = (aiResponse: string): ParsedActionPayload | null => {
  const candidates: string[] = [];

  const tagged = extractTaggedBlock(aiResponse, 'nexus_action_json');
  if (tagged) candidates.push(tagged);

  const jsonBlocks = [...aiResponse.matchAll(/```json\s*([\s\S]*?)\s*```/ig)].map(m => m[1]);
  if (jsonBlocks.length) {
    candidates.push(jsonBlocks[jsonBlocks.length - 1]);
  }

  const first = aiResponse.indexOf('{');
  const last = aiResponse.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    candidates.push(aiResponse.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseCandidateJson(candidate);
    if (parsed?.action) return parsed;
  }
  return null;
};

const minContentLengthForAction = (action: BrainActionType): number => {
  if (action === 'replace_all') return 40;
  if (action === 'create_note' || action === 'create_folder' || action === 'move_note' || action === 'open_note' || action === 'rename_note' || action === 'delete_item' || action === 'ask_question') return 0;
  if (action === 'edit_note') return 2;
  return 8;
};

export const inferActionContentFromResponse = (action: BrainActionType, aiResponse: string): string | undefined => {
  const tagged = extractTaggedBlock(aiResponse, 'nexus_content');
  const aggressive = action !== 'replace_all';
  if (tagged) {
    const cleanedTagged = sanitizeProposedMarkdown(tagged, { aggressive });
    if (cleanedTagged && cleanedTagged.length >= minContentLengthForAction(action) && !isUiTranscriptNoise(cleanedTagged)) {
      return cleanedTagged;
    }
  }

  const withoutPayload = aiResponse
    .replace(/<nexus_action_json>[\s\S]*?<\/nexus_action_json>/ig, '')
    .replace(/```json[\s\S]*?```/ig, '')
    .replace(/\{[\s\S]*"action"\s*:\s*"(?:insert_content|create_note|edit_note|create_folder|move_note|open_note|rename_note|delete_item|ask_question|replace_selection|insert_at_cursor|find_and_replace|replace_all)"[\s\S]*\}$/i, '')
    .trim();

  const cleaned = sanitizeProposedMarkdown(withoutPayload, { aggressive });
  if (cleaned && cleaned.length >= minContentLengthForAction(action) && !isUiTranscriptNoise(cleaned)) {
    return cleaned;
  }

  const blocks = [...aiResponse.matchAll(/```(?!json)([a-zA-Z0-9_-]*)\n([\s\S]*?)```/ig)];
  for (const b of blocks) {
    const candidate = sanitizeProposedMarkdown((b[2] || '').trim(), { aggressive });
    if (candidate && candidate.length >= minContentLengthForAction(action) && !isUiTranscriptNoise(candidate)) {
      return candidate;
    }
  }

  return undefined;
};
