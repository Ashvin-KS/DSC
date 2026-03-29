import React, { useEffect, useMemo, useState } from 'react';
import {
  Key, Brain, Activity, HardDrive, Info, Eye, EyeOff, Save, CheckCircle, RefreshCw, Search, Loader2,
  Bell, Palette, Languages, Download, Upload, Trash2, ShieldCheck, Monitor
} from 'lucide-react';
import { AppSettings, useIntentStore } from '../store/useIntentStore';

const DEFAULT_SETTINGS: AppSettings = {
  nvidiaApiKey: '',
  openaiApiKey: '',
  anthropicApiKey: '',
  groqApiKey: '',
  googleClientId: '',
  googleClientSecret: '',
  aiProvider: 'nvidia',
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

const PROVIDERS = [
  { id: 'nvidia', label: 'NVIDIA NIM' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'groq', label: 'Groq' },
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
          className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-4 py-2.5 pr-10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
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

export const SettingsView: React.FC = () => {
  const { settings, setSettings } = useIntentStore();
  const [local, setLocal] = useState<AppSettings>(settings ?? DEFAULT_SETTINGS);
  const [activeSection, setActiveSection] = useState<SectionId>('api');
  const [saved, setSaved] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelSearch, setModelSearch] = useState('');

  const [validationMsg, setValidationMsg] = useState('');
  const [validationOk, setValidationOk] = useState<boolean | null>(null);
  const [validating, setValidating] = useState(false);

  const [storageStats, setStorageStats] = useState<any>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageMsg, setStorageMsg] = useState('');

  const currentProviderKey = useMemo(() => {
    const provider = (local.aiProvider || 'nvidia').toLowerCase();
    if (provider === 'openai') return local.openaiApiKey || '';
    if (provider === 'anthropic') return local.anthropicApiKey || '';
    if (provider === 'groq') return local.groqApiKey || '';
    return local.nvidiaApiKey || '';
  }, [local.aiProvider, local.nvidiaApiKey, local.openaiApiKey, local.anthropicApiKey, local.groqApiKey]);

  const set = <K extends keyof AppSettings>(key: K) => (val: AppSettings[K]) => setLocal((p) => ({ ...p, [key]: val }));

  const loadStorageStats = async () => {
    try {
      const stats = await window.nexusAPI?.storage?.getStats?.();
      if (stats) setStorageStats(stats);
    } catch {
      setStorageMsg('Unable to fetch storage stats.');
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        if (window.nexusAPI?.settings) {
          const data = await window.nexusAPI.settings.get();
          if (data) {
            const merged = { ...DEFAULT_SETTINGS, ...data };
            setLocal(merged);
            setSettings(merged);
          }
        }
      } catch {
        setLocal(DEFAULT_SETTINGS);
      }
      await loadStorageStats();
    };
    load();
  }, [setSettings]);

  const fetchModels = async () => {
    if ((local.aiProvider || 'nvidia') !== 'nvidia') {
      setModelsError('Model fetch is currently available only for NVIDIA provider.');
      return;
    }
    if (!local.nvidiaApiKey) {
      setModelsError('Enter NVIDIA API key first.');
      return;
    }
    setModelsLoading(true);
    setModelsError('');
    try {
      const data = await window.nexusAPI?.settings?.getNvidiaModels?.(local.nvidiaApiKey);
      const ids: string[] = (data ?? []).map((m: any) => m.id ?? m).filter(Boolean).sort();
      setModels(ids);
    } catch (e: any) {
      setModelsError(`Failed to fetch models: ${e.message || e}`);
    } finally {
      setModelsLoading(false);
    }
  };

  const validateCurrentKey = async () => {
    setValidationMsg('');
    setValidationOk(null);
    setValidating(true);
    try {
      const provider = local.aiProvider || 'nvidia';
      const result = await window.nexusAPI?.settings?.validateApiKey?.(provider, currentProviderKey);
      setValidationOk(!!result?.valid);
      setValidationMsg(result?.message || (result?.valid ? 'Valid key' : 'Invalid key'));
    } catch (e: any) {
      setValidationOk(false);
      setValidationMsg(`Validation failed: ${e.message || e}`);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSettings(local);
    try {
      if (window.nexusAPI?.settings) await window.nexusAPI.settings.save(local);
      await loadStorageStats();
    } catch {
      // keep local settings
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClearStorage = async () => {
    if (!confirm('Clear all activity/chat/diary/dashboard data? This cannot be undone.')) return;
    setStorageBusy(true);
    setStorageMsg('');
    try {
      await window.nexusAPI?.storage?.clearAll?.();
      setStorageMsg('Storage cleared successfully.');
      await loadStorageStats();
    } catch (e: any) {
      setStorageMsg(`Failed to clear storage: ${e.message || e}`);
    } finally {
      setStorageBusy(false);
    }
  };

  const handleExport = async () => {
    const path = window.prompt('Export path (example: C:\\\\Users\\\\you\\\\allentire-backup.json)');
    if (!path) return;
    setStorageBusy(true);
    setStorageMsg('');
    try {
      await window.nexusAPI?.storage?.exportData?.(path);
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
      await window.nexusAPI?.storage?.importData?.(path, replace);
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
          {activeSection === 'api' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white">API Provider & Keys</h2>
                <p className="text-xs text-gray-500">Switch provider and validate keys before saving.</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-400 block mb-2">AI Provider</label>
                <select
                  value={local.aiProvider || 'nvidia'}
                  onChange={(e) => set('aiProvider')(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-gray-200"
                >
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>

              <SecretInput label="NVIDIA API Key" value={local.nvidiaApiKey || ''} onChange={set('nvidiaApiKey')} />
              <SecretInput label="OpenAI API Key" value={local.openaiApiKey || ''} onChange={set('openaiApiKey')} />
              <SecretInput label="Anthropic API Key" value={local.anthropicApiKey || ''} onChange={set('anthropicApiKey')} />
              <SecretInput label="Groq API Key" value={local.groqApiKey || ''} onChange={set('groqApiKey')} />
              <SecretInput label="Google Client ID" value={local.googleClientId} onChange={set('googleClientId')} />
              <SecretInput label="Google Client Secret" value={local.googleClientSecret} onChange={set('googleClientSecret')} />

              <div className="flex items-center gap-2">
                <button
                  onClick={validateCurrentKey}
                  disabled={validating}
                  className="px-3 py-2 text-xs rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300 hover:text-white disabled:opacity-50"
                >
                  {validating ? 'Testing...' : 'Test Active Provider Key'}
                </button>
                {validationMsg && (
                  <p className={`text-xs ${validationOk ? 'text-green-400' : 'text-red-400'}`}>{validationMsg}</p>
                )}
              </div>
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
                    className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg pl-8 pr-4 py-2 text-xs text-gray-300"
                  />
                </div>
                <button
                  onClick={fetchModels}
                  disabled={modelsLoading}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#282828] text-xs text-gray-400 hover:text-white disabled:opacity-50"
                >
                  {modelsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {models.length === 0 ? 'Fetch' : 'Refresh'}
                </button>
              </div>
              {modelsError && <p className="text-xs text-red-400">{modelsError}</p>}
              <input
                value={local.defaultModel}
                onChange={(e) => set('defaultModel')(e.target.value)}
                placeholder="Manual model id"
                className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-gray-200 font-mono"
              />
              <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {models.filter((m) => m.toLowerCase().includes(modelSearch.toLowerCase())).map((m) => (
                  <button
                    key={m}
                    onClick={() => set('defaultModel')(m)}
                    className={`w-full flex items-center gap-3 px-4 py-2 rounded-xl border text-left text-xs ${local.defaultModel === m ? 'border-cyan-500/30 bg-cyan-500/5 text-cyan-300' : 'border-[#1a1a1a] bg-[#0a0a0a] text-gray-400 hover:text-gray-200'}`}
                  >
                    <Brain size={12} />
                    <span className="flex-1 truncate font-mono">{m}</span>
                    {local.defaultModel === m && <CheckCircle size={12} className="text-cyan-400" />}
                  </button>
                ))}
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
                    className="w-full min-h-[96px] bg-[#0a0a0a] border border-[#222] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600"
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
                  <input type="number" min={1} max={3650} value={local.dataRetentionDays} onChange={(e) => set('dataRetentionDays')(Number(e.target.value) || 30)} className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-3 py-2 text-sm text-gray-200" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-400 block mb-2">Max Storage (MB)</label>
                  <input type="number" min={64} max={10240} value={local.maxStorageMb || 512} onChange={(e) => set('maxStorageMb')(Number(e.target.value) || 512)} className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-3 py-2 text-sm text-gray-200" />
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
                    <select value={local.startupBehavior || 'minimized_to_tray'} onChange={(e) => set('startupBehavior')(e.target.value)} className="w-full bg-[#0a0a0a] border border-[#222] rounded-lg px-4 py-2.5 text-sm text-gray-200">
                      <option value="normal">Normal (Visible)</option>
                      <option value="minimized_to_tray">Silent (Minimized to Tray)</option>
                    </select>
                  </div>
                )}

                <Toggle label="Minimize to Tray" desc="Minimize the app to the system tray instead of taskbar." checked={!!local.minimizeToTray} onChange={set('minimizeToTray')} />
                <Toggle label="Close to Tray" desc="Closing the window hides it to the tray." checked={!!local.closeToTray} onChange={set('closeToTray')} />
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="space-y-5">
              <h2 className="text-lg font-bold text-white">Theme & Appearance</h2>
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
                <div className="flex justify-between text-sm"><span className="text-gray-500">App</span><span className="text-gray-300 font-medium">Allentire + IntentFlow</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Runtime</span><span className="text-gray-300 font-medium">Tauri 2 + React 18</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Provider Support</span><span className="text-gray-300 font-medium">NVIDIA, OpenAI, Anthropic, Groq</span></div>
              </div>
            </div>
          )}

          {activeSection !== 'about' && (
            <button
              onClick={handleSave}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold ${saved ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/15'}`}
            >
              {saved ? <><CheckCircle size={15} /> Saved!</> : <><Save size={15} /> Save Changes</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
