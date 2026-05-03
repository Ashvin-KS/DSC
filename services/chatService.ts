/**
 * Chat service — wraps window.atheletiaAPI.intent.* and window.atheletiaAPI.settings.*
 * so ChatPage doesn't depend on intent-flow-main's separate Tauri invocations.
 */
import type { ChatSession, ChatMessage, ChatSourceId } from '../lib/chatTypes';

export interface ModelInfo {
  id: string;
  name: string;
}

export interface RecentModel {
  id: string;
  name: string;
  use_count: number;
  last_used: number;
}

/** Typed error thrown when a chat service call fails. */
export class ChatServiceError extends Error {
  constructor(
    message: string,
    public readonly code: 'API_UNAVAILABLE' | 'NETWORK' | 'AUTH' | 'NOT_FOUND' | 'UNKNOWN'
  ) {
    super(message);
    this.name = 'ChatServiceError';
  }
}

/** Returns the atheletiaAPI bridge or throws if unavailable. */
function getApi() {
  const api = (window as { atheletiaAPI?: typeof window.atheletiaAPI }).atheletiaAPI;
  if (!api) {
    throw new ChatServiceError(
      'Atheletia API bridge is not available. Make sure you are running inside the desktop app.',
      'API_UNAVAILABLE'
    );
  }
  return api;
}

/** Maps raw backend errors to user-friendly ChatServiceError instances. */
function mapError(err: unknown): ChatServiceError {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('api key') || lower.includes('missing') || lower.includes('unauthorized') || lower.includes('401')) {
    return new ChatServiceError(
      'Authentication failed. Please check your API key in Settings → API Keys.',
      'AUTH'
    );
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('connect')) {
    return new ChatServiceError(
      'Connection error. Please check your internet connection and try again.',
      'NETWORK'
    );
  }
  if (lower.includes('not found') || lower.includes('404')) {
    return new ChatServiceError('The requested resource was not found.', 'NOT_FOUND');
  }
  return new ChatServiceError(msg || 'An unexpected error occurred.', 'UNKNOWN');
}

export async function createChatSession(): Promise<ChatSession> {
  try {
    const result = await getApi().intent?.createChatSession();
    if (!result) throw new ChatServiceError('Backend returned empty session.', 'UNKNOWN');
    return result as ChatSession;
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function getChatSessions(): Promise<ChatSession[]> {
  try {
    const result = await getApi().intent?.getChatSessions();
    return (result as ChatSession[]) ?? [];
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  try {
    await getApi().intent?.deleteChatSession(sessionId);
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function getChatMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    const result = await getApi().intent?.getChatMessages(sessionId);
    return (result as ChatMessage[]) ?? [];
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function sendChatMessage(
  sessionId: string,
  message: string,
  model?: string,
  provider?: string,
  timeRange?: string,
  selectedSources?: ChatSourceId[],
  apiKey?: string
): Promise<ChatMessage> {
  try {
    const result = await getApi().intent?.sendChatMessage(
      sessionId, message, model, provider, timeRange, selectedSources, undefined, apiKey
    );
    if (!result) throw new ChatServiceError('Backend returned no response.', 'UNKNOWN');
    return result as ChatMessage;
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function getNvidiaModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const models = await getApi().settings?.getNvidiaModels(apiKey);
    return ((models ?? []) as Array<{ id: string }>).map((m) => ({ id: m.id, name: m.id }));
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function getLMStudioModels(baseUrl = 'http://127.0.0.1:1234'): Promise<ModelInfo[]> {
  try {
    const models = await getApi().settings?.getLMStudioModels(baseUrl);
    return ((models ?? []) as Array<{ id: string }>).map((m) => ({ id: m.id, name: m.id }));
  } catch (err) {
    throw err instanceof ChatServiceError ? err : mapError(err);
  }
}

export async function getRecentModels(_limit = 5): Promise<RecentModel[]> {
  // Backend doesn't expose recent models via atheletiaAPI — localStorage only
  return [];
}

export async function removeRecentModel(_modelId: string): Promise<void> {
  // no-op
}
