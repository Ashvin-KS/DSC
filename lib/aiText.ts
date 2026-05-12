export type ConversationLikeMessage = {
  role?: string;
  sender?: 'ai' | 'user' | string;
  content?: string;
  text?: string;
  isAction?: boolean;
};

const INTERNAL_PREFIX_PATTERNS = [
  /^(?:the user|user) (?:asks|asked|says|said|wants|is asking)\b/i,
  /^(?:i|we) (?:should|need to|will|must|can) \b/i,
  /^let(?:'s| me) \b/i,
  /^thinking process\b/i,
  /^according to (?:the )?instructions\b/i,
  /^based on (?:the )?(?:provided )?(?:context|note|evidence)\b/i,
];

export function stripThinkBlocks(input: string): string {
  return (input || '')
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, '');
}

export function sanitizeAiVisibleText(input: string): string {
  let text = stripThinkBlocks(input || '');

  text = text
    .replace(/```(?:json)?\s*[\s\S]*?"(?:tool|args|action)"[\s\S]*?```/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
    .replace(/<\|[^>]*?(?:tool|function|reasoning)[^>]*?\|>/gi, '')
    .replace(/\[TOOL_CALL[^\]]*\][\s\S]*?(?=\n\n|$)/gi, '')
    .replace(/<atheletia_action_json[^>]*>[\s\S]*?<\/atheletia_action_json>/gi, '')
    .replace(/<atheletia_action_json[^>]*>[\s\S]*$/gi, '')
    .replace(/<atheletia_mcq_json[^>]*>[\s\S]*?<\/atheletia_mcq_json>/gi, '')
    .replace(/<atheletia_mcq_json[^>]*>[\s\S]*$/gi, '')
    .replace(/<atheletia_content[^>]*>[\s\S]*?<\/atheletia_content>/gi, '')
    .replace(/<atheletia_content[^>]*>[\s\S]*$/gi, '')
    .replace(/^\s*,?\s*"reasoning"\s*:\s*"(?:(?:\\"|[^"])*)"\s*,?\s*$/gim, '')
    .replace(/^\s*"reasoning_content"\s*:\s*"(?:(?:\\"|[^"])*)"\s*,?\s*$/gim, '')
    .replace(/\bThinking Process\s*\n+[\s\S]*?(?=\n#{1,6}\s|\n\d+\.|\n[A-Z][^\n]{0,80}\n|$)/gi, '');

  const paragraphs = text.split(/\n{2,}/);
  let dropCount = 0;
  for (let i = 0; i < paragraphs.length - 1; i += 1) {
    const para = paragraphs[i].trim();
    if (!para) {
      dropCount = i + 1;
      continue;
    }
    if (INTERNAL_PREFIX_PATTERNS.some((pattern) => pattern.test(para))) {
      dropCount = i + 1;
      continue;
    }
    break;
  }
  if (dropCount > 0) {
    text = paragraphs.slice(dropCount).join('\n\n');
  }

  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^["{},\][\s,]*$/.test(trimmed)) return false;
      return !INTERNAL_PREFIX_PATTERNS.some((pattern) => pattern.test(trimmed));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeAiHistoryText(input: string): string {
  return sanitizeAiVisibleText(input)
    .replace(/\[\[IF_ACTION:\{[\s\S]*?\}\]\]/gi, '')
    .trim();
}

export function isFollowUpPrompt(input: string): boolean {
  const text = (input || '').trim().toLowerCase();
  if (!text) return false;
  if (text.length > 220) return false;
  return /\b(above|previous|last|that|this|these|those|each|same|continue|explain|explanations?|answer key|answers?|shorter|longer|rewrite|format|table|mcq|questions?)\b/.test(text)
    && !/\b(today|yesterday|last week|this week|activity|screen|browser|music history|file changes)\b/.test(text);
}

export function buildRecentConversationContext(
  messages: ConversationLikeMessage[],
  currentPrompt: string,
  maxMessages = 8,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const clean = messages
    .filter((message) => !message.isAction)
    .map((message) => {
      const role = message.role
        ? (message.role === 'assistant' || message.role === 'ai' ? 'assistant' : 'user')
        : (message.sender === 'ai' ? 'assistant' : 'user');
      const content = sanitizeAiHistoryText(String(message.content ?? message.text ?? ''));
      return { role: role as 'user' | 'assistant', content };
    })
    .filter((message) => message.content.trim().length > 0);

  const recent = clean.slice(-maxMessages);
  if (!isFollowUpPrompt(currentPrompt)) return recent;

  const lastAssistant = [...clean].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant) return recent;

  return [
    ...recent,
    {
      role: 'user',
      content: `Follow-up context: the next user message refers to this previous assistant answer. Use it as the primary context.\n\n${lastAssistant.content}`,
    },
  ];
}

export const VISUALIZE_INFO_RE = /(?:^|\s)(?:html\s+visualize|visualize-html)(?:\s|$)/i;
