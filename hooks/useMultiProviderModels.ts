import { useState, useEffect, useCallback } from 'react';
import { fetchAllProviderModels, ProviderModelGroup, inferProviderFromModel } from '../lib/modelFetch';
export { inferProviderFromModel } from '../lib/modelFetch';
import type { ModelInfo } from '../services/chatService';

export interface ModelWithProvider extends ModelInfo {
  provider: string;
}

export function useMultiProviderModels(settings: Record<string, any> | null) {
  const [groups, setGroups] = useState<ProviderModelGroup[]>([]);
  const [allModels, setAllModels] = useState<ModelWithProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAllProviderModels(settings);
      setGroups(result.groups);
      const models = result.allModels as ModelWithProvider[];
      setAllModels(models);
      if (result.error) setError(result.error);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [settings]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { groups, allModels, loading, error, refetch };
}

export function getStoredModelWithProvider(storageKey: string): { model: string; provider: string } | null {
  try {
    const model = localStorage.getItem(storageKey);
    if (!model) return null;
    const provider = localStorage.getItem(`${storageKey}_provider`);
    return {
      model,
      provider: provider || inferProviderFromModel(model),
    };
  } catch {
    return null;
  }
}

export function setStoredModelWithProvider(storageKey: string, model: string, provider?: string) {
  try {
    localStorage.setItem(storageKey, model);
    localStorage.setItem(`${storageKey}_provider`, provider || inferProviderFromModel(model));
  } catch {
    // ignore storage errors
  }
}
