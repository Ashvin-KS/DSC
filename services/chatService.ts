/**
 * Chat service — wraps window.nexusAPI.intent.* and window.nexusAPI.settings.*
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

const api = () => (window as any).nexusAPI;

export async function createChatSession(): Promise<ChatSession> {
  return api()?.intent?.createChatSession();
}

export async function getChatSessions(): Promise<ChatSession[]> {
  return api()?.intent?.getChatSessions() ?? [];
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  return api()?.intent?.deleteChatSession(sessionId);
}

export async function getChatMessages(sessionId: string): Promise<ChatMessage[]> {
  return api()?.intent?.getChatMessages(sessionId) ?? [];
}

export async function sendChatMessage(
  sessionId: string,
  message: string,
  model?: string,
  provider?: string,
  timeRange?: string,
  selectedSources?: ChatSourceId[]
): Promise<ChatMessage> {
  return api()?.intent?.sendChatMessage(sessionId, message, model, provider, timeRange, selectedSources);
}

export async function getNvidiaModels(apiKey: string): Promise<ModelInfo[]> {
  const models = await api()?.settings?.getNvidiaModels(apiKey);
  return (models ?? []).map((m: any) => ({ id: m.id, name: m.id }));
}

export async function getLMStudioModels(baseUrl = 'http://127.0.0.1:1234'): Promise<ModelInfo[]> {
  const models = await api()?.settings?.getLMStudioModels(baseUrl);
  return (models ?? []).map((m: any) => ({ id: m.id, name: m.id }));
}

export async function getRecentModels(_limit = 5): Promise<RecentModel[]> {
  // Main app doesn't expose recent models via nexusAPI — use localStorage only
  return [];
}

export async function removeRecentModel(_modelId: string): Promise<void> {
  // no-op
}
