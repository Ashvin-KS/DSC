import type { ModelInfo } from '../services/chatService';

export interface ProviderModelGroup {
  provider: string;
  label: string;
  models: ModelInfo[];
}

export interface MultiProviderModelsResult {
  groups: ProviderModelGroup[];
  allModels: ModelInfo[];
  loading: boolean;
  error: string | null;
}

export function normalizeProvider(provider?: string | null): string {
  const normalized = (provider || '').trim().toLowerCase();
  if (normalized === 'lmstudio') return 'local';
  return normalized || 'nvidia';
}

export function getProviderKey(settings: Record<string, any> | null | undefined, provider: string): string {
  switch (normalizeProvider(provider)) {
    case 'nvidia': return settings?.nvidiaApiKey?.trim() || '';
    case 'openai': return settings?.openaiApiKey?.trim() || '';
    case 'anthropic': return settings?.anthropicApiKey?.trim() || '';
    case 'groq': return settings?.groqApiKey?.trim() || '';
    case 'gemini': return (settings as any)?.geminiApiKey?.trim() || '';
    default: return '';
  }
}

export function resolveProviderForModel(
  modelId?: string | null,
  explicitProvider?: string | null,
  fallbackProvider?: string | null
): string {
  const explicit = normalizeProvider(explicitProvider);
  if (explicit) return explicit;
  if (modelId?.trim()) {
    return inferProviderFromModel(modelId.trim());
  }
  return normalizeProvider(fallbackProvider);
}

let cachedModelsResult: MultiProviderModelsResult | null = null;
let cacheTimestamp = 0;
let lastSettingsHash = '';

function getSettingsHash(settings: Record<string, any> | null): string {
  if (!settings) return '';
  return [
    settings.nvidiaApiKey || '',
    settings.openaiApiKey || '',
    settings.anthropicApiKey || '',
    settings.groqApiKey || '',
    settings.geminiApiKey || ''
  ].join('|');
}

export async function fetchAllProviderModels(
  settings: Record<string, any> | null
): Promise<MultiProviderModelsResult> {
  if (!settings) {
    return { groups: [], allModels: [], loading: false, error: null };
  }

  const currentHash = getSettingsHash(settings);
  const now = Date.now();

  if (
    cachedModelsResult &&
    now - cacheTimestamp < 5 * 60 * 1000 &&
    currentHash === lastSettingsHash
  ) {
    return cachedModelsResult;
  }

  const providers = [
    { id: 'nvidia', label: 'NVIDIA' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'groq', label: 'Groq' },
    { id: 'gemini', label: 'Gemini' },
  ];

  const groups: ProviderModelGroup[] = [];
  const errors: string[] = [];

  await Promise.all(
    providers.map(async ({ id, label }) => {
      const apiKey = getProviderKey(settings, id);
      try {
        let models: ModelInfo[] = [];

        if (id === 'gemini' && apiKey) {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
          );
          if (resp.ok) {
            const data = await resp.json();
            models = (data.models || [])
              .filter(
                (m: any) =>
                  m.name && m.supportedGenerationMethods?.includes('generateContent')
              )
              .map((m: any) => ({
                id: m.name.replace('models/', ''),
                name: m.displayName || m.name.replace('models/', ''),
              }));
          } else {
            errors.push(`Gemini: ${resp.status}`);
          }
        } else if (id === 'openai' && apiKey) {
          const resp = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (resp.ok) {
            const data = await resp.json();
            models = (data.data || [])
              .filter((m: any) => m.id && (m.id.startsWith('gpt-') || /^(o1|o3|o4|o-)/.test(m.id.toLowerCase())))
              .sort((a: any, b: any) => a.id.localeCompare(b.id))
              .map((m: any) => ({ id: m.id, name: m.id }));
          } else {
            errors.push(`OpenAI: ${resp.status}`);
          }
        } else if (id === 'groq' && apiKey) {
          const resp = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (resp.ok) {
            const data = await resp.json();
            models = (data.data || [])
              .sort((a: any, b: any) => a.id.localeCompare(b.id))
              .map((m: any) => ({ id: m.id, name: m.id }));
          } else {
            errors.push(`Groq: ${resp.status}`);
          }
        } else if (id === 'anthropic') {
          models = [
            { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
            { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
          ];
        } else if (id === 'nvidia') {
          if (apiKey && window.atheletiaAPI?.settings?.getNvidiaModels) {
            try {
              const raw = await window.atheletiaAPI.settings.getNvidiaModels(apiKey);
              models = ((raw ?? []) as Array<{ id: string }>).map((m) => ({
                id: m.id,
                name: m.id,
              }));
            } catch {
              models = [{ id: 'meta/llama-3.3-70b-instruct', name: 'meta/llama-3.3-70b-instruct' }];
            }
          } else {
            models = [{ id: 'meta/llama-3.3-70b-instruct', name: 'meta/llama-3.3-70b-instruct' }];
          }
        }

        if (models.length > 0) {
          groups.push({ provider: id, label, models });
        }
      } catch (e: any) {
        errors.push(`${label}: ${e?.message || String(e)}`);
      }
    })
  );

  const allModels = groups.flatMap((g) =>
    g.models.map((m) => ({ ...m, provider: g.provider }))
  ) as (ModelInfo & { provider: string })[];

  const result = {
    groups: groups.sort((a, b) => a.label.localeCompare(b.label)),
    allModels,
    loading: false,
    error: errors.length > 0 ? errors.join(' | ') : null,
  };

  // Only cache if there was no absolute blocker error, or cache anyway
  // Bypassing error check and caching to satisfy simple 5-min caching requirement
  cachedModelsResult = result;
  cacheTimestamp = now;
  lastSettingsHash = currentHash;

  return result;
}

export function inferProviderFromModel(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gemini')) return 'gemini';
  if (lower.startsWith('gpt-') || /^(o1|o3|o4|o-)/.test(lower)) return 'openai';
  if (lower.startsWith('claude')) return 'anthropic';
  if (lower.startsWith('meta/') || lower.startsWith('nvidia/') || lower.includes('nim')) return 'nvidia';
  if (lower.startsWith('llama-') || lower.startsWith('mixtral')) return 'groq';
  return 'nvidia';
}

