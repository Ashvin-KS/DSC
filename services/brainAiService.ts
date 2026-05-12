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

import { buildRecentConversationContext, sanitizeAiHistoryText } from '../lib/aiText';

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

interface LineRange {
  startLine: number;
  endLine: number;
}

interface NoteSection {
  title: string;
  startLine: number;
  endLine: number;
  text: string;
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

const rangesOverlap = (left: LineRange, right: LineRange): boolean =>
  left.startLine <= right.endLine && right.startLine <= left.endLine;

const mergeLineRanges = (ranges: LineRange[], gap = 1): LineRange[] => {
  const sorted = [...ranges]
    .filter(range => range.startLine > 0 && range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine);
  if (!sorted.length) return [];

  const merged: LineRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.startLine <= last.endLine + gap) {
      last.endLine = Math.max(last.endLine, range.endLine);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
};

const buildRangeWindow = (content: string, range: LineRange, pad = 2, maxLines = 40): string => {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, range.startLine - pad);
  const end = Math.min(lines.length, Math.max(range.endLine + pad, range.startLine));
  const clippedEnd = Math.min(end, start + maxLines - 1);
  return lines
    .slice(start - 1, clippedEnd)
    .map((line, index) => `${start + index}| ${line}`)
    .join('\n');
};

const collectKeywordHitRanges = (content: string, query: string, maxHits = 6): LineRange[] => {
  const terms = getQueryTerms(query);
  if (!terms.length) return [];
  const hits: LineRange[] = [];
  for (const line of toLineRecords(content)) {
    const lowered = line.text.toLowerCase();
    if (!terms.some(term => lowered.includes(term))) continue;
    hits.push({ startLine: line.line, endLine: line.line });
    if (hits.length >= maxHits) break;
  }
  return mergeLineRanges(hits, 2);
};

const buildNoteSections = (content: string): NoteSection[] => {
  const lines = content.split(/\r?\n/);
  if (!lines.length) return [];

  const headingIndexes = lines
    .map((text, index) => ({ text, index }))
    .filter(line => /^#{1,6}\s+/.test(line.text));

  if (!headingIndexes.length) {
    return [{
      title: 'Full note',
      startLine: 1,
      endLine: lines.length,
      text: lines.join('\n')
    }];
  }

  const sections: NoteSection[] = [];
  if (headingIndexes[0].index > 0) {
    sections.push({
      title: 'Opening lines',
      startLine: 1,
      endLine: headingIndexes[0].index,
      text: lines.slice(0, headingIndexes[0].index).join('\n')
    });
  }

  for (let index = 0; index < headingIndexes.length; index += 1) {
    const current = headingIndexes[index];
    const next = headingIndexes[index + 1];
    const startLine = current.index + 1;
    const endLine = next ? next.index : lines.length;
    sections.push({
      title: current.text.trim(),
      startLine,
      endLine,
      text: lines.slice(current.index, endLine).join('\n')
    });
  }

  return sections.filter(section => section.text.trim().length > 0);
};

const findSectionForRange = (sections: NoteSection[], range: LineRange): NoteSection | null => {
  const overlapping = sections.find(section =>
    rangesOverlap(range, { startLine: section.startLine, endLine: section.endLine })
  );
  if (overlapping) return overlapping;

  const midpoint = Math.floor((range.startLine + range.endLine) / 2);
  return sections.find(section => midpoint >= section.startLine && midpoint <= section.endLine) || null;
};

const retrieveParentSections = (
  content: string,
  query: string,
  selectedText?: string,
  selectedRange?: LineRange | null,
  topK = 3
): NoteSection[] => {
  const sections = buildNoteSections(content);
  if (!sections.length) return [];

  const chunkQueryTerms = getQueryTerms(query);
  const selectedTerms = getQueryTerms(selectedText || '');
  const rankedSections = new Map<string, { section: NoteSection; score: number }>();
  const chunks = buildRagChunks(content, 24, 6);

  for (const chunk of chunks) {
    const score = scoreRagChunk(chunk, chunkQueryTerms, selectedText);
    if (score <= 0) continue;
    const section = findSectionForRange(sections, { startLine: chunk.startLine, endLine: chunk.endLine });
    if (!section) continue;
    const key = `${section.startLine}-${section.endLine}`;
    const existing = rankedSections.get(key);
    rankedSections.set(key, {
      section,
      score: Math.max(existing?.score || 0, score),
    });
  }

  if (selectedRange) {
    const selectedSection = findSectionForRange(sections, selectedRange);
    if (selectedSection) {
      const key = `${selectedSection.startLine}-${selectedSection.endLine}`;
      rankedSections.set(key, {
        section: selectedSection,
        score: (rankedSections.get(key)?.score || 0) + 6,
      });
    }
  }

  for (const section of sections) {
    const haystack = section.text.toLowerCase();
    let score = 0;
    for (const term of chunkQueryTerms) {
      if (haystack.includes(term)) score += 2;
    }
    for (const term of selectedTerms) {
      if (haystack.includes(term)) score += 1;
    }
    if (score <= 0) continue;
    const key = `${section.startLine}-${section.endLine}`;
    rankedSections.set(key, {
      section,
      score: Math.max(rankedSections.get(key)?.score || 0, score),
    });
  }

  return [...rankedSections.values()]
    .sort((left, right) => right.score - left.score || left.section.startLine - right.section.startLine)
    .slice(0, topK)
    .map(item => item.section);
};

const trimToBudget = (input: string, budget: number): string =>
  input.length <= budget ? input : `${input.slice(0, budget)}\n...(truncated)...`;

export const buildBrainNoteContext = (params: {
  content: string;
  userMessage: string;
  notePath?: string | null;
  selectedText?: string;
  selectedRange?: { startLine: number; endLine: number } | null;
  maxChars?: number;
}): string => {
  const {
    content,
    userMessage,
    notePath,
    selectedText,
    selectedRange,
    maxChars = 9000,
  } = params;

  if (!content.trim()) {
    return notePath ? `Current note path: ${notePath}\n\nThe note is empty.` : 'No note currently open.';
  }

  const noteName = notePath?.split(/[/\\]/).pop() || 'Current note';
  const sections: string[] = [
    `NOTE\nTitle: ${noteName}${notePath ? `\nPath: ${notePath}` : ''}`
  ];

  const consumedRanges: LineRange[] = [];
  if (selectedRange) {
    consumedRanges.push(selectedRange);
    sections.push(
      `ACTIVE SELECTION\nLines ${selectedRange.startLine}-${selectedRange.endLine}\n${buildRangeWindow(content, selectedRange, 2, 32)}`
    );
  } else if (selectedText?.trim()) {
    sections.push(`ACTIVE SELECTION\n${trimToBudget(selectedText.trim(), 800)}`);
  }

  sections.push(`HEADING OUTLINE\n${buildHeadingOutline(content, 24)}`);

  const keywordRanges = collectKeywordHitRanges(content, `${userMessage}\n${selectedText || ''}`, 6)
    .filter(range => !consumedRanges.some(existing => rangesOverlap(existing, range)));
  if (keywordRanges.length) {
    consumedRanges.push(...keywordRanges);
    sections.push(
      `KEYWORD HITS\n${keywordRanges
        .map(range => `Lines ${range.startLine}-${range.endLine}\n${buildRangeWindow(content, range, 1, 18)}`)
        .join('\n\n')}`
    );
  }

  const parentSections = retrieveParentSections(content, userMessage, selectedText, selectedRange, 3)
    .filter(section => !consumedRanges.some(range =>
      rangesOverlap(range, { startLine: section.startLine, endLine: section.endLine })
    ));
  if (parentSections.length) {
    sections.push(
      `RELEVANT SECTIONS\n${parentSections
        .map(section => `${section.title} [${section.startLine}-${section.endLine}]\n${trimToBudget(section.text, 1800)}`)
        .join('\n\n---\n\n')}`
    );
  }

  const shouldUseFallback = !selectedRange && !keywordRanges.length && !parentSections.length;
  if (shouldUseFallback) {
    const fallbackRange = { startLine: 1, endLine: Math.min(content.split(/\r?\n/).length, 80) };
    sections.push(`RAW FALLBACK\n${buildRangeWindow(content, fallbackRange, 0, 80)}`);
  }

  const prompt = sections.join('\n\n');
  return trimToBudget(prompt, maxChars);
};

export const isUiTranscriptNoise = (text: string): boolean => {
  const t = text || '';
  const patterns = [
    /dashboard\s*\n\s*chat\s*\n\s*activity/i,
    /atheletia ai can make mistakes/i,
    /ask atheletia about this note/i,
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

export const buildModelConversation = (messages: BrainChatMessage[], aiMode: 'lecture' | 'edit' | 'mcq') => {
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
  const maxUser = aiMode === 'edit' ? 8 : 20;
  const maxAi = aiMode === 'edit' ? 6 : 15;

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

  const ordered = selected.reverse().map(m => ({
    sender: m.sender,
    text: sanitizeAiHistoryText(sanitizeMessageForModel(m.text)),
  }));
  const currentPrompt = ordered[ordered.length - 1]?.sender === 'user' ? ordered[ordered.length - 1].text : '';
  return buildRecentConversationContext(ordered, currentPrompt, ordered.length);
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

  const tagged = extractTaggedBlock(aiResponse, 'atheletia_action_json');
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
  const tagged = extractTaggedBlock(aiResponse, 'atheletia_content');
  const aggressive = action !== 'replace_all';
  if (tagged) {
    const cleanedTagged = sanitizeProposedMarkdown(tagged, { aggressive });
    if (cleanedTagged && cleanedTagged.length >= minContentLengthForAction(action) && !isUiTranscriptNoise(cleanedTagged)) {
      return cleanedTagged;
    }
  }

  const withoutPayload = aiResponse
    .replace(/<atheletia_action_json>[\s\S]*?<\/atheletia_action_json>/ig, '')
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
