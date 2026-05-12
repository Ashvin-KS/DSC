import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Key, Brain, Activity, HardDrive, Info, Eye, EyeOff, Save, CheckCircle, RefreshCw, Search, Loader2,
  Bell, Palette, Languages, Download, Upload, Trash2, ShieldCheck, Monitor
} from 'lucide-react';
import { AppSettings, useIntentStore } from '../store/useIntentStore';
import { THEME_GROUPS, getThemePreset, resolveColorSchemeForTheme, type ThemePresetId } from '../lib/theme';
import { useMultiProviderModels } from '../hooks/useMultiProviderModels';
import { inferProviderFromModel } from '../lib/modelFetch';

const DEFAULT_SETTINGS: AppSettings = {
  nvidiaApiKey: '',
  openaiApiKey: '',
  anthropicApiKey: '',
  groqApiKey: '',
  geminiApiKey: '',
  googleClientId: '',
  googleClientSecret: '',
  defaultModel: 'meta/llama-3.3-70b-instruct',
  trackApps: true,
  trackScreenOcr: false,
  trackMedia: true,
  trackBrowser: false,
  excludedApps: [],
  dataRetentionDays: 30,
  maxStorageMb: 512,
  autoCleanup: true,
  enableStartup: true,
  startupBehavior: 'minimized_to_tray',
  minimizeToTray: true,
  closeToTray: true,
  compactMode: false,
  fontScale: 1,
  colorScheme: 'dark',
  themePreset: 'dark-2026',
};

type SectionId = 'api' | 'ai' | 'tracking' | 'storage' | 'system' | 'appearance' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: React.ElementType }[] = [
  { id: 'api', label: 'API Keys', icon: Key },
  { id: 'ai', label: 'AI Model', icon: Brain },
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'tracking', label: 'Privacy', icon: ShieldCheck },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

function SecretInput({ label, value, onChange, helpText }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  helpText?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-gray-400">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter API key"
          className="w-full bg-[#141414] border border-[#222] rounded-lg px-4 py-2.5 pr-10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        />
        <button type="button" onClick={() => setShow((p) => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300">
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {helpText && <p className="text-[10px] text-gray-600">{helpText}</p>}
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-[#1a1a1a] last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-200">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
      </div>
      <button onClick={() => onChange(!checked)} className={`relative w-10 h-[22px] rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-[#333]'}`}>
        <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

function normalizeSettings(data?: Partial<AppSettings> | null): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(data || {}),
    colorScheme: data?.colorScheme || DEFAULT_SETTINGS.colorScheme,
    themePreset: data?.themePreset || (data?.colorScheme === 'light' ? 'light-2026' : 'dark-2026'),
  };
}

export const SettingsView: React.FC = () => {
  const { settings, setSettings } = useIntentStore();
  const [local, setLocal] = useState<AppSettings>(settings ?? DEFAULT_SETTINGS);
  const [activeSection, setActiveSection] = useState<SectionId>('api');
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatusMsg, setSaveStatusMsg] = useState('');

  const [modelSearch, setModelSearch] = useState('');
  const { groups: modelGroups, allModels: allCloudModels, loading: modelsLoading, error: modelsErrorRaw, refetch: refetchModels } = useMultiProviderModels(local);
  const modelsError = modelsErrorRaw ? String(modelsErrorRaw) : '';

  const [storageStats, setStorageStats] = useState<any>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageMsg, setStorageMsg] = useState('');

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const initialSettingsRef = useRef(settings);
  const settingsLoadedRef = useRef(false);
  const lastSavedSettingsRef = useRef('');

  const set = <K extends keyof AppSettings>(key: K) => (val: AppSettings[K]) => setLocal((p) => ({ ...p, [key]: val }));
  const setThemePreset = (themePreset: ThemePresetId) =>
    setLocal((prev) => ({
      ...prev,
      themePreset,
      colorScheme: resolveColorSchemeForTheme(themePreset),
    }));

  const loadStorageStats = useCallback(async () => {
    try {
      if (!window.atheletiaAPI?.storage?.getStats) {
        setStorageMsg('Storage bridge is unavailable in this runtime.');
        return;
      }
      const stats = await window.atheletiaAPI.storage.getStats();
      if (stats) {
        setStorageStats(stats);
        setStorageMsg('');
      }
    } catch (error) {
      setStorageMsg(`Unable to fetch storage stats: ${getErrorMessage(error, 'Unknown error')}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let merged = normalizeSettings(initialSettingsRef.current);
        if (window.atheletiaAPI?.settings?.get) {
          const data = await window.atheletiaAPI.settings.get();
          if (data) merged = normalizeSettings(data);
        }
        if (!cancelled) {
          setLocal(merged);
          setSettings(merged);
          lastSavedSettingsRef.current = JSON.stringify(merged);
        }
      } catch (error) {
        const fallback = normalizeSettings(initialSettingsRef.current);
        if (!cancelled) {
          setLocal(fallback);
          lastSavedSettingsRef.current = JSON.stringify(fallback);
          setSaveStatusMsg(`Unable to load saved settings: ${getErrorMessage(error, 'Unknown error')}`);
        }
      } finally {
        if (!cancelled) {
          settingsLoadedRef.current = true;
          await loadStorageStats();
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [loadStorageStats, setSettings]);

  const handleSave = useCallback(async () => {
    const next = { ...local, aiProvider: inferProviderFromModel(local.defaultModel || '') };
    setSettings(next);
    setIsSaving(true);
    setSaveStatusMsg('');
    try {
      if (!window.atheletiaAPI?.settings?.save) {
        setSaveStatusMsg('Settings saved locally, but the backend bridge is unavailable.');
        return;
      }
      await window.atheletiaAPI.settings.save(next);
      lastSavedSettingsRef.current = JSON.stringify(next);
      await loadStorageStats();
    } catch (error) {
      setSaveStatusMsg(`Failed to save settings: ${getErrorMessage(error, 'Unknown error')}`);
    } finally {
      setIsSaving(false);
    }
  }, [loadStorageStats, local, setSettings]);

  // Auto-save with debouncing
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    if (JSON.stringify(local) === lastSavedSettingsRef.current) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      handleSave();
    }, 1500); // Save 1.5 seconds after last change

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [handleSave, local]);

  const handleClearStorage = async () => {
    if (!confirm('Clear all activity/chat/diary/dashboard data? This cannot be undone.')) return;
    setStorageBusy(true);
    setStorageMsg('');
    try {
      await window.atheletiaAPI?.storage?.clearAll?.();
      setStorageMsg('Storage cleared successfully.');
      await loadStorageStats();
    } catch (e: any) {
      setStorageMsg(`Failed to clear storage: ${e.message || e}`);
    } finally {
      setStorageBusy(false);
    }
  };

  const handleExport = async () => {
    const path = window.prompt('Export path (example: C:\\\\Users\\\\you\\\\atheletia-backup.json)');
    if (!path) return;
    setStorageBusy(true);
    setStorageMsg('');
    try {
      await window.atheletiaAPI?.storage?.exportData?.(path);
      setStorageMsg('Data exported.');
    } catch (e: any) {
      setStorageMsg(`Export failed: ${e.message || e}`);
    } finally {
      setStorageBusy(false);
    }
  };

  const handleImport = async () => {
    const path = window.prompt('Import file path');
    if (!path) return;
    const replace = confirm('Replace existing data before import?');
    setStorageBusy(true);
    setStorageMsg('');
    try {
      await window.atheletiaAPI?.storage?.importData?.(path, replace);
      setStorageMsg('Data imported.');
      await loadStorageStats();
    } catch (e: any) {
      setStorageMsg(`Import failed: ${e.message || e}`);
    } finally {
      setStorageBusy(false);
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-52 flex-shrink-0 border-r border-[#1e1e1e] flex flex-col py-6 px-3 gap-1">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const isActive = activeSection === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm ${isActive ? 'bg-[#1a1a1a] text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]'}`}
            >
              <Icon size={15} className={isActive ? 'text-cyan-400' : ''} />
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-2xl space-y-8">
          {saveStatusMsg && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
              {saveStatusMsg}
            </div>
          )}

          {activeSection === 'api' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">API Keys</h2>
                <p className="text-xs text-gray-500">Add keys for any providers you want to use. Atheletia routes requests by the selected model.</p>
              </div>

              <SecretInput label="NVIDIA API Key" value={local.nvidiaApiKey || ''} onChange={set('nvidiaApiKey')} helpText="Get from build.nvidia.com" />
              <SecretInput label="OpenAI API Key" value={local.openaiApiKey || ''} onChange={set('openaiApiKey')} helpText="sk-... from platform.openai.com" />
              <SecretInput label="Anthropic API Key" value={local.anthropicApiKey || ''} onChange={set('anthropicApiKey')} helpText="From console.anthropic.com" />
              <SecretInput label="Groq API Key" value={local.groqApiKey || ''} onChange={set('groqApiKey')} helpText="From console.groq.com" />
              <SecretInput label="Google Gemini API Key" value={(local as any).geminiApiKey || ''} onChange={(v) => setLocal((p) => ({ ...p, geminiApiKey: v }))} helpText="aistudio.google.com/app/apikey" />

            </div>
          )}

          {activeSection === 'ai' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">AI Model</h2>
                <p className="text-xs text-gray-500">Default model used for chat/diary summaries.</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
                  <input
                    type="text"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                    className="w-full bg-[#141414] border border-[#222] rounded-lg pl-8 pr-4 py-2 text-xs text-gray-300"
                  />
                </div>
                <button
                  onClick={refetchModels}
                  disabled={modelsLoading}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#282828] text-xs text-gray-400 hover:text-white disabled:opacity-50"
                >
                  {modelsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Refresh
                </button>
              </div>
              {modelsError && <p className="text-xs text-red-400">{modelsError}</p>}
              <input
                value={local.defaultModel}
                onChange={(e) => set('defaultModel')(e.target.value)}
                placeholder="Manual model id"
                className="w-full bg-[#141414] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-gray-200 font-mono"
              />
              <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {modelsLoading ? (
                  <div className="px-4 py-3 flex items-center justify-center gap-2">
                    <Loader2 size={14} className="animate-spin text-cyan-400" />
                    <span className="text-xs text-gray-500">Loading models...</span>
                  </div>
                ) : (() => {
                  const filteredGroups = modelGroups.map(group => ({
                    ...group,
                    models: group.models.filter(m => {
                      const q = modelSearch.toLowerCase();
                      return (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
                    })
                  })).filter(g => g.models.length > 0);
                  const manualMatch = local.defaultModel && !filteredGroups.some(g => g.models.some(m => m.id === local.defaultModel));
                  return (
                    <>
                      {filteredGroups.length === 0 && !manualMatch && (
                        <div className="px-4 py-3 text-center">
                          <p className="text-xs text-gray-500">No models found. Add an API key above, or type a model ID.</p>
                        </div>
                      )}
                      {filteredGroups.map(group => (
                        <div key={group.provider} className="border-b border-[#1a1a1a] last:border-b-0">
                          <div className="px-3 py-1.5 bg-white/5">
                            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{group.label}</p>
                          </div>
                          {group.models.map(m => (
                            <button
                              key={m.id}
                              onClick={() => {
                                set('defaultModel')(m.id);
                              }}
                              className={`w-full flex items-center gap-3 px-4 py-2 rounded-xl border text-left text-xs ${local.defaultModel === m.id ? 'border-cyan-500/30 bg-cyan-500/5 text-cyan-300' : 'border-[#1a1a1a] bg-[#141414] text-gray-400 hover:text-gray-200'}`}
                            >
                              <Brain size={12} />
                              <span className="flex-1 truncate font-mono">{m.name || m.id}</span>
                              {local.defaultModel === m.id && <CheckCircle size={12} className="text-cyan-400" />}
                            </button>
                          ))}
                        </div>
                      ))}
                      {manualMatch && (
                        <button
                          onClick={() => set('defaultModel')(local.defaultModel)}
                          className={`w-full flex items-center gap-3 px-4 py-2 rounded-xl border text-left text-xs ${'border-cyan-500/30 bg-cyan-500/5 text-cyan-300'}`}
                        >
                          <Brain size={12} />
                          <span className="flex-1 truncate font-mono">{local.defaultModel}</span>
                          <CheckCircle size={12} className="text-cyan-400" />
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {activeSection === 'tracking' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">Privacy Controls</h2>
                <p className="text-xs text-gray-500">Granular data source controls.</p>
              </div>
              <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-2xl px-5 divide-y divide-[#1a1a1a]">
                <Toggle label="App & Window Tracking" desc="Track active app/window usage." checked={!!local.trackApps} onChange={set('trackApps')} />
                <Toggle label="Screen OCR" desc="Read text from screen snapshots." checked={!!local.trackScreenOcr} onChange={set('trackScreenOcr')} />
                <Toggle label="Media Tracking" desc="Track media playback context." checked={!!local.trackMedia} onChange={set('trackMedia')} />
                <Toggle label="Browser Tracking" desc="Track browser title/URL metadata." checked={!!local.trackBrowser} onChange={set('trackBrowser')} />
                <div className="py-3 border-b border-[#1a1a1a] last:border-0">
                  <label className="text-sm font-medium text-gray-200 block mb-1">Excluded Apps</label>
                  <p className="text-xs text-gray-500 mb-2">One app per line. Matching apps are skipped from activity tracking.</p>
                  <textarea
                    value={(local.excludedApps || []).join('\n')}
                    onChange={(e) => set('excludedApps')(e.target.value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean))}
                    placeholder="spotify\nchrome\ntelegram"
                    className="w-full min-h-[96px] bg-[#141414] border border-[#222] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600"
                  />
                </div>
              </div>
            </div>
          )}

          {activeSection === 'storage' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">Storage</h2>
                <p className="text-xs text-gray-500">Usage, cleanup, and data export/import.</p>
              </div>

              <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-4 space-y-2 text-xs">
                <p className="text-gray-300">Occupied: <span className="text-cyan-400 font-semibold">{formatBytes(storageStats?.totalSizeBytes || 0)}</span></p>
                <p className="text-gray-500">Activities: {storageStats?.activitiesCount ?? 0} | Chat: {storageStats?.chatMessagesCount ?? 0} | Diary: {storageStats?.diaryEntriesCount ?? 0}</p>
                <p className="text-gray-600 truncate">DB: {storageStats?.dbPath || 'Unavailable'}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-400 block mb-2">Retention Days</label>
                  <input type="number" min={1} max={3650} value={local.dataRetentionDays} onChange={(e) => set('dataRetentionDays')(Number(e.target.value) || 30)} className="w-full bg-[#141414] border border-[#222] rounded-lg px-3 py-2 text-sm text-gray-200" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-400 block mb-2">Max Storage (MB)</label>
                  <input type="number" min={64} max={10240} value={local.maxStorageMb || 512} onChange={(e) => set('maxStorageMb')(Number(e.target.value) || 512)} className="w-full bg-[#141414] border border-[#222] rounded-lg px-3 py-2 text-sm text-gray-200" />
                </div>
              </div>
              <Toggle label="Auto Cleanup" desc="Auto-purge oldest data when max storage is exceeded." checked={!!local.autoCleanup} onChange={set('autoCleanup')} />

              <div className="flex flex-wrap gap-2">
                <button onClick={loadStorageStats} className="px-3 py-2 text-xs rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300"><RefreshCw size={12} className="inline mr-1" />Refresh</button>
                <button onClick={handleExport} disabled={storageBusy} className="px-3 py-2 text-xs rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300"><Download size={12} className="inline mr-1" />Export</button>
                <button onClick={handleImport} disabled={storageBusy} className="px-3 py-2 text-xs rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300"><Upload size={12} className="inline mr-1" />Import</button>
                <button onClick={handleClearStorage} disabled={storageBusy} className="px-3 py-2 text-xs rounded-lg bg-red-500/10 border border-red-500/30 text-red-300"><Trash2 size={12} className="inline mr-1" />Clear All</button>
              </div>
              {storageMsg && <p className="text-xs text-gray-400">{storageMsg}</p>}
            </div>
          )}

          {activeSection === 'system' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">System Settings</h2>
                <p className="text-xs text-gray-500">Startup and tray behavior options.</p>
              </div>
              <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-2xl px-5 divide-y divide-[#1a1a1a]">
                <Toggle label="Launch on Startup" desc="Automatically start the app when you sign in." checked={!!local.enableStartup} onChange={set('enableStartup')} />

                {local.enableStartup && (
                  <div className="py-3 border-b border-[#1a1a1a] last:border-0">
                    <label className="text-sm font-medium text-gray-200 block mb-1">Startup Behavior</label>
                    <p className="text-xs text-gray-500 mb-2">How the app should appear on startup.</p>
                    <select value={local.startupBehavior || 'minimized_to_tray'} onChange={(e) => set('startupBehavior')(e.target.value)} className="w-full bg-[#141414] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-gray-200">
                      <option value="normal">Normal (Visible)</option>
                      <option value="minimized_to_tray">Silent (Minimized to Tray)</option>
                    </select>
                  </div>
                )}

                <Toggle label="Minimize to Tray" desc="Minimize the app to the system tray instead of taskbar." checked={!!local.minimizeToTray} onChange={set('minimizeToTray')} />
                <Toggle label="Close to Tray" desc="Closing the window hides it to the tray." checked={!!local.closeToTray} onChange={set('closeToTray')} />
                <Toggle
                  label="Auto-Create Diary"
                  desc="At midnight, automatically generate yesterday's AI diary summary. Runs silently in the background."
                  checked={!!(local as any).autoCreateDiary}
                  onChange={(v) => setLocal((p) => ({ ...p, autoCreateDiary: v } as any))}
                />
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">Theme & Appearance</h2>
                <p className="text-xs text-gray-500">Choose a full app theme, then tune density and text scale.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-400 block mb-2">Theme Preset</label>
                  <div className="rounded-2xl border border-[#1a1a1a] bg-[#0d0d0d] p-3">
                    {THEME_GROUPS.map((group) => (
                      <div key={group.label} className="mb-4 last:mb-0">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{group.label}</p>
                        <div className="space-y-1">
                          {group.ids.map((themeId) => {
                            const theme = getThemePreset(themeId);
                            const isSelected = (local.themePreset || 'dark-2026') === themeId;
                            return (
                              <button
                                key={themeId}
                                type="button"
                                onClick={() => setThemePreset(themeId)}
                                className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors ${
                                  isSelected
                                    ? 'border-cyan-500/40 bg-cyan-500/10 text-white'
                                    : 'border-transparent bg-[#141414] text-gray-300 hover:border-[#2a2a2a] hover:bg-[#1a1a1a]'
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-medium">{theme.label}</div>
                                  <div className="text-[11px] text-gray-500">{theme.scheme === 'light' ? 'Default Light' : 'Default Dark'}</div>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span className="h-3 w-3 rounded-full border border-white/10" style={{ backgroundColor: theme.vars['--bg-canvas'] }} />
                                  <span className="h-3 w-3 rounded-full border border-white/10" style={{ backgroundColor: theme.vars['--bg-elev-2'] }} />
                                  <span className="h-3 w-3 rounded-full border border-white/10" style={{ backgroundColor: theme.vars['--accent'] }} />
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <Toggle label="Compact Mode" desc="Reduce spacing and density." checked={!!local.compactMode} onChange={set('compactMode')} />
              <div>
                <label className="text-xs font-semibold text-gray-400 block mb-2">Font Scale ({(local.fontScale || 1).toFixed(2)}x)</label>
                <input type="range" min={0.8} max={1.3} step={0.05} value={local.fontScale || 1} onChange={(e) => set('fontScale')(Number(e.target.value))} className="w-full" />
              </div>
            </div>
          )}

          {activeSection === 'about' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-white">About</h2>
              <div className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-2xl p-5 space-y-3">
                <div className="flex justify-between text-sm"><span className="text-gray-500">App</span><span className="text-gray-300 font-medium">Atheletia</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Runtime</span><span className="text-gray-300 font-medium">Tauri 2 + React 18</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Provider Support</span><span className="text-gray-300 font-medium">NVIDIA, OpenAI, Anthropic, Groq, Gemini</span></div>
              </div>
            </div>
          )}

          {activeSection !== 'about' && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              {isSaving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle size={12} className="text-green-500" />
                  Auto-saved
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
