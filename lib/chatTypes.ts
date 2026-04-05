// ─── Chat Types (ported from intent-flow-main) ────────────────────────────────

export interface ChatSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export type ChatSourceId = 'apps' | 'screen' | 'media' | 'browser' | 'files';

export interface AgentStep {
  turn: number;
  tool_name: string;
  tool_args: Record<string, unknown>;
  tool_result: string;
  reasoning: string;
}

export interface ActivityRef {
  app: string;
  title: string;
  time: number;
  duration_seconds: number;
  category: string;
  media?: { title: string; artist: string; status: string } | null;
  ocr_snippet?: string;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: AgentStep[];
  activities?: ActivityRef[];
  created_at: number;
}

// ─── Settings shape exposed by useSettings hook ───────────────────────────────

export interface AISettings {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'local' | 'nvidia' | 'lmstudio';
  api_key: string;
  model: string;
  local_only: boolean;
  fallback_to_local: boolean;
  lmstudio_url?: string;
}

export interface Settings {
  ai: AISettings;
}
